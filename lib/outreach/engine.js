// The outreach loop. Each "tick" (every 30 min on weekdays, from the
// GitHub Actions schedule, or the dashboard's Run button) does, in order:
//
//   1. inbox   — read new mail: replies stop follow-ups, bounces and
//                "no thanks" close the prospect out
//   2. send    — within sending hours and the daily cap: approved first
//                emails, highest fit first, then follow-ups that are due
//   3. source  — if fewer than `min_pipeline` prospects are waiting, sweep
//                the next town (least recently swept)
//   4. enrich  — read websites + registry for new prospects, score them,
//                write the draft
//   5. crm     — push anything not yet synced to the class CRM
//
// Every step is bounded so a tick fits in one serverless call. Nothing is
// emailed unless it's been approved (or auto-queue is on and it clears
// the fit bar with a non-guessed address).

const { sourceTownFromOsm, sourceTownFromRegistry } = require('./sources');
const { enrichProspect } = require('./enrich');
const { scoreProspect } = require('./score');
const { draftInitial, composeFollowup } = require('./compose');
const mailer = require('./mailer');
const crm = require('./crm');
const { nameKey, nyParts, nyStartOfDay, businessDaysSince, sleep, mapLimit } = require('./util');

const OPEN = ['new', 'ready', 'queued'];

function defaultDeps() {
  return {
    fetchImpl: fetch,
    resolver: undefined,
    now: () => new Date(),
    sleep,
    mailer,
    crm,
    sourceOsm: sourceTownFromOsm,
    sourceRegistry: sourceTownFromRegistry,
    enrich: enrichProspect,
    draft: draftInitial,
  };
}

function inSendWindow(settings, now) {
  const { hour, weekday } = nyParts(now);
  if (settings.send_weekdays_only && (weekday === 'Sat' || weekday === 'Sun')) return false;
  return hour >= settings.send_start_hour && hour < settings.send_end_hour;
}

// ---------- 1. inbox ----------

async function inboxStep(store, settings, deps) {
  if (!deps.mailer.mailConfig().configured) return { skipped: 'Gmail not connected' };
  const sentStatuses = ['sent', 'followed_up', 'replied', 'sending', 'sending_followup'];
  const prospects = await store.listProspects({ statuses: sentStatuses, limit: 5000 });
  const known = { emails: new Map(), domains: new Map(), messageIds: new Map() };
  for (const p of prospects) {
    if (p.email) known.emails.set(p.email.toLowerCase(), p.id);
    if (p.domain) known.domains.set(p.domain.toLowerCase(), p.id);
  }
  for (const m of await store.sentMessageIndex()) known.messageIds.set(m.message_id, m.prospect_id);
  if (!known.emails.size) return { checked: 0 };

  const incoming = await deps.mailer.checkInbox(known, { sinceDays: 4 });
  let handled = 0;
  for (const r of incoming) {
    if (await store.messageExists(r.messageId)) continue;
    const p = await store.getProspect(r.prospectId);
    if (!p) continue;
    await store.insertMessage({
      prospect_id: p.id, kind: r.kind === 'bounce' ? 'bounce' : 'reply', direction: 'in', status: 'received',
      subject: r.subject, body: r.snippet, from_email: r.fromAddress, message_id: r.messageId, in_reply_to: r.inReplyTo, sent_at: r.date,
    });
    handled++;
    if (r.kind === 'auto_reply') {
      await store.addEvent(p.id, 'auto_reply', `Auto-reply from ${r.fromAddress}: ${r.subject}`);
      continue;
    }
    if (r.kind === 'bounce') {
      await store.updateProspect(p.id, { status: 'bounced', last_error: `Bounced: ${r.bouncedAddress || p.email}` });
      await store.addEvent(p.id, 'bounced', `${p.email} bounced`);
      continue;
    }
    const status = r.kind === 'not_interested' ? 'not_interested' : 'replied';
    await store.updateProspect(p.id, { status, replied_at: r.date });
    await store.addEvent(p.id, status === 'replied' ? 'replied' : 'opted_out', `${p.contact_name || r.fromAddress}: "${r.snippet.slice(0, 220)}"`);
    if (deps.crm.crmConfig().configured && p.crm_org_id) {
      try {
        await deps.crm.syncReply(p, r, { todayYmd: nyParts(deps.now()).ymd, fetchImpl: deps.fetchImpl });
      } catch (err) {
        await store.addEvent(p.id, 'error', `CRM: ${err.message}`);
      }
    }
  }
  return { checked: incoming.length, new: handled };
}

// ---------- 2. send ----------

async function sendOne(store, settings, deps, p, { kind }) {
  const messages = await store.listMessages(p.id);
  let msg;
  if (kind === 'initial') {
    msg = messages.filter(m => m.direction === 'out' && m.kind === 'initial' && m.status !== 'sent').pop();
    if (!msg) throw new Error('No draft to send');
  } else {
    const first = messages.find(m => m.direction === 'out' && m.kind === 'initial' && m.status === 'sent');
    if (!first) throw new Error('No first email to follow up on');
    const fu = composeFollowup(p, settings, first.subject);
    msg = await store.insertMessage({ prospect_id: p.id, kind: 'followup', direction: 'out', status: 'queued', subject: fu.subject, body: fu.body, to_email: p.email, in_reply_to: first.message_id });
  }
  const first = messages.find(m => m.direction === 'out' && m.kind === 'initial' && m.status === 'sent');
  const { messageId } = await deps.mailer.sendMail({
    to: p.email,
    subject: msg.subject,
    text: msg.body,
    fromName: settings.sender_name,
    inReplyTo: kind === 'followup' ? first?.message_id : undefined,
    references: kind === 'followup' ? first?.message_id : undefined,
  });
  const sentAt = deps.now().toISOString();
  await store.updateMessage(msg.id, { status: 'sent', message_id: messageId, sent_at: sentAt, to_email: p.email, from_email: deps.mailer.mailConfig().user, error: null });
  return { ...msg, message_id: messageId, sent_at: sentAt };
}

async function sendStep(store, settings, deps, { force = null, deadline = Infinity } = {}) {
  if (!deps.mailer.mailConfig().configured) return { skipped: 'Gmail not connected' };
  const now = deps.now();
  if (!force && !inSendWindow(settings, now)) return { skipped: 'Outside sending hours' };
  const sentToday = await store.sentCountSince(nyStartOfDay(now));
  let room = Math.max(0, settings.daily_cap - sentToday);
  if (!room) return { skipped: `Daily cap reached (${settings.daily_cap})` };
  room = force ? 1 : Math.min(room, settings.per_tick);

  const results = [];
  const crmOn = deps.crm.crmConfig().configured;
  const dayStart = nyStartOfDay(now);
  // Re-checked before every send, so an overlapping run can't push past the cap.
  const underCap = async () => (await store.sentCountSince(dayStart)) < settings.daily_cap;
  const todayYmd = nyParts(now).ymd;

  let queue = force ? [await store.getProspect(force)].filter(Boolean) : await store.listProspects({ statuses: ['queued'], order: 'fit_score', ascending: false, limit: room });
  if (force && queue[0] && !['queued', 'ready'].includes(queue[0].status)) throw new Error(`Can't send from status "${queue[0].status}"`);

  for (const p of queue) {
    if (results.length >= room || Date.now() > deadline) break;
    if (!p.email) continue;
    if (!(await underCap())) break;
    if (!(await store.claim(p.id, p.status, 'sending'))) continue;
    try {
      if (results.length) await deps.sleep(4000 + Math.random() * 5000); // don't fire them all in the same second
      const sent = await sendOne(store, settings, deps, p, { kind: 'initial' });
      await store.updateProspect(p.id, { status: 'sent', sent_at: sent.sent_at, last_error: null });
      await store.addEvent(p.id, 'sent', `Emailed ${p.contact_name ? `${p.contact_name} at ` : ''}${p.email}: "${sent.subject}"`);
      results.push({ id: p.id, name: p.name, kind: 'initial' });
      if (crmOn && !p.crm_org_id) {
        try {
          const orgId = await deps.crm.syncSent(p, sent, { todayYmd, followupDays: settings.followup_after_days, fetchImpl: deps.fetchImpl });
          await store.updateProspect(p.id, { crm_org_id: orgId, crm_synced_at: deps.now().toISOString() });
          await store.addEvent(p.id, 'crm', 'Added to the class CRM as Contacted');
        } catch (err) {
          await store.addEvent(p.id, 'error', `CRM: ${err.message}`);
        }
      }
    } catch (err) {
      await store.updateProspect(p.id, { status: 'ready', last_error: `Send failed: ${err.message}` });
      await store.addEvent(p.id, 'error', `Send failed: ${err.message}`);
      results.push({ id: p.id, name: p.name, error: err.message });
    }
  }

  // Follow-ups that are due.
  if (!force && settings.followups_enabled && results.length < room) {
    const sent = await store.listProspects({ statuses: ['sent'], order: 'sent_at', ascending: true, limit: 200 });
    for (const p of sent) {
      if (results.length >= room || Date.now() > deadline) break;
      if (!p.sent_at || businessDaysSince(p.sent_at, now) < settings.followup_after_days) continue;
      if (!(await underCap())) break;
      if (!(await store.claim(p.id, 'sent', 'sending_followup'))) continue;
      try {
        if (results.length) await deps.sleep(4000 + Math.random() * 5000);
        const msg = await sendOne(store, settings, deps, p, { kind: 'followup' });
        await store.updateProspect(p.id, { status: 'followed_up', followup_at: msg.sent_at, last_error: null });
        await store.addEvent(p.id, 'followup', `Followed up with ${p.email}`);
        results.push({ id: p.id, name: p.name, kind: 'followup' });
        if (crmOn && p.crm_org_id) await deps.crm.syncFollowup(p, msg, deps.fetchImpl).catch(err => store.addEvent(p.id, 'error', `CRM: ${err.message}`));
      } catch (err) {
        await store.updateProspect(p.id, { status: 'sent', last_error: `Follow-up failed: ${err.message}` });
        await store.addEvent(p.id, 'error', `Follow-up failed: ${err.message}`);
        results.push({ id: p.id, name: p.name, error: err.message });
      }
    }
  }
  return { sent: results.filter(r => !r.error).length, results, sentToday: sentToday + results.filter(r => !r.error).length };
}

// ---------- 3. source ----------

async function sourceStep(store, settings, deps, { town: onlyTown = null, force = false } = {}) {
  if (!force) {
    const counts = await store.countByStatus();
    const open = OPEN.reduce((n, s) => n + (counts[s] || 0), 0);
    if (open >= settings.min_pipeline) return { skipped: `${open} prospects already waiting` };
  }
  const towns = (await store.listTowns()).filter(t => t.enabled);
  if (!towns.length) return { skipped: 'No towns to search' };
  towns.sort((a, b) => (a.last_sourced_at ? new Date(a.last_sourced_at).getTime() : 0) - (b.last_sourced_at ? new Date(b.last_sourced_at).getTime() : 0));
  const town = onlyTown || towns[0].town;

  const found = [];
  const errors = [];
  if (settings.use_osm) {
    try { found.push(...await deps.sourceOsm(town, deps.fetchImpl)); } catch (err) { errors.push(`OpenStreetMap: ${err.message}`); }
  }
  if (settings.use_registry) {
    try { found.push(...await deps.sourceRegistry(town, deps.fetchImpl)); } catch (err) { errors.push(`CT registry: ${err.message}`); }
  }

  const excluded = new Set((await store.listExcluded()).map(e => e.name_key));
  const known = await store.knownKeys();
  const seen = new Set();
  const rows = [];
  for (const p of found) {
    if (!p.name_key || excluded.has(p.name_key) || known.names.has(p.name_key) || seen.has(p.name_key)) continue;
    if (p.domain && known.domains.has(p.domain)) continue;
    if (p.miles_from_storrs != null && Number(p.miles_from_storrs) > settings.max_miles) continue;
    seen.add(p.name_key);
    rows.push({ ...p, status: 'new' });
  }
  const inserted = await store.insertProspects(rows);
  await store.upsertTown({ town, enabled: true, last_sourced_at: deps.now().toISOString(), last_found: inserted.length });
  await store.addEvent(null, 'sourced', `${town}: ${inserted.length} new businesses found${errors.length ? ` (${errors.join('; ')})` : ''}`);
  return { town, found: found.length, added: inserted.length, errors };
}

// ---------- 4. enrich + score + draft ----------

async function enrichStep(store, settings, deps, { limit = 6, deadline = Infinity, ids = null } = {}) {
  let batch;
  if (ids) batch = (await Promise.all(ids.map(id => store.getProspect(id)))).filter(Boolean);
  else batch = await store.listProspects({ statuses: ['new'], order: 'created_at', ascending: true, limit, maxAttempts: 3, full: true });
  if (!batch.length) return { enriched: 0 };

  const excluded = new Set((await store.listExcluded()).map(e => e.name_key));
  const out = await mapLimit(batch, 3, async p => {
    if (Date.now() > deadline) return null;
    if (excluded.has(p.name_key)) {
      await store.updateProspect(p.id, { status: 'skipped', notes: 'Already in the class CRM' });
      return { id: p.id, status: 'skipped' };
    }
    try {
      const patch = await deps.enrich(p, { fetchImpl: deps.fetchImpl, resolver: deps.resolver, useRegistry: settings.use_registry });
      const merged = { ...p, ...patch };
      Object.assign(merged, scoreProspect(merged));
      let status = merged.email ? 'ready' : 'no_email';
      if (status === 'ready') {
        const draft = await deps.draft(merged, settings, deps.fetchImpl);
        const existing = (await store.listMessages(p.id)).filter(m => m.kind === 'initial' && m.status !== 'sent');
        if (existing.length) await store.updateMessage(existing[existing.length - 1].id, { subject: draft.subject, body: draft.body, to_email: merged.email });
        else await store.insertMessage({ prospect_id: p.id, kind: 'initial', direction: 'out', status: 'draft', subject: draft.subject, body: draft.body, to_email: merged.email });
        if (settings.auto_queue && merged.fit_score >= settings.auto_queue_min_fit && merged.email_source !== 'guess') status = 'queued';
      }
      await store.updateProspect(p.id, {
        ...patch,
        fit_score: merged.fit_score,
        fit_reasons: merged.fit_reasons,
        status,
        enrich_attempts: (p.enrich_attempts || 0) + 1,
      });
      await store.addEvent(p.id, 'enriched', status === 'no_email'
        ? 'Read their site; no email address found'
        : `Fit ${merged.fit_score}/100 · ${merged.email}${status === 'queued' ? ' · auto-queued' : ' · draft ready for review'}`);
      return { id: p.id, status, fit: merged.fit_score };
    } catch (err) {
      await store.updateProspect(p.id, { enrich_attempts: (p.enrich_attempts || 0) + 1, last_error: `Enrich failed: ${err.message}` });
      return { id: p.id, error: err.message };
    }
  });
  return { enriched: out.filter(Boolean).length, results: out.filter(Boolean) };
}

// ---------- 5. CRM catch-up + exclusions ----------

async function crmStep(store, settings, deps) {
  if (!deps.crm.crmConfig().configured) return { skipped: 'CRM not connected' };
  const out = { synced: 0, excluded: 0 };
  // Refresh the do-not-email list from the CRM about once a day.
  const last = settings._crm_names_at ? new Date(settings._crm_names_at) : null;
  if (!last || deps.now() - last > 20 * 3600 * 1000) {
    try {
      const names = await deps.crm.listCrmNames(deps.fetchImpl);
      const mine = new Set((await store.listProspects({ statuses: ['sent', 'followed_up', 'replied', 'not_interested', 'bounced'], limit: 5000 })).map(p => p.name_key));
      const rows = names.map(n => ({ name_key: nameKey(n), name: n, reason: 'In class CRM' })).filter(r => !mine.has(r.name_key));
      await store.upsertExcluded(rows);
      out.excluded = rows.length;
      await store.saveSettings({ ...(await store.getRawSettings()), _crm_names_at: deps.now().toISOString() });
    } catch (err) {
      out.error = err.message;
    }
  }
  const unsynced = (await store.listProspects({ statuses: ['sent', 'followed_up', 'replied'], limit: 20 })).filter(p => !p.crm_org_id);
  for (const p of unsynced.slice(0, 5)) {
    try {
      const full = await store.getProspect(p.id);
      const first = (await store.listMessages(p.id)).find(m => m.kind === 'initial' && m.status === 'sent');
      if (!first) continue;
      const orgId = await deps.crm.syncSent(full, first, { todayYmd: nyParts(deps.now()).ymd, followupDays: settings.followup_after_days, fetchImpl: deps.fetchImpl });
      await store.updateProspect(p.id, { crm_org_id: orgId, crm_synced_at: deps.now().toISOString() });
      out.synced++;
    } catch (err) {
      out.error = err.message;
      break;
    }
  }
  return out;
}

// ---------- the tick ----------

async function tick(store, depsIn = {}, { budgetMs = 50000 } = {}) {
  const deps = { ...defaultDeps(), ...depsIn };
  const started = Date.now();
  const deadline = started + budgetMs;
  const settings = await store.getSettings();
  const report = {};
  const step = async (name, fn) => {
    if (Date.now() > deadline) { report[name] = { skipped: 'out of time' }; return; }
    try { report[name] = await fn(); } catch (err) { report[name] = { error: err.message }; }
  };
  await step('inbox', () => inboxStep(store, settings, deps));
  await step('send', () => sendStep(store, settings, deps, { deadline: deadline - 5000 }));
  await step('source', () => sourceStep(store, settings, deps));
  await step('enrich', () => enrichStep(store, settings, deps, { limit: 6, deadline: deadline - 8000 }));
  await step('crm', () => crmStep(store, settings, deps));
  report.ms = Date.now() - started;
  try {
    await store.saveSettings({ ...(await store.getRawSettings()), _last_tick_at: deps.now().toISOString() });
  } catch (err) { /* not worth failing the run over */ }
  return report;
}

module.exports = { tick, inboxStep, sendStep, sourceStep, enrichStep, crmStep, inSendWindow, defaultDeps };
