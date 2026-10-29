// Gives every name on the desk a source: the CT filing that lists the person
// (by the business's filing id) or the page of their website the name is on.
// A name we can't point back to a source is dropped; if it was the contact,
// the draft's greeting falls back to the people on the filing, or the team.
//
//   node scripts/outreach-sources.js --docs <dir of prospect JSON files> --out out [--restore names.json] [--only ids.json]
//
// Writes out/sources.json: [{ id, data }] updates to apply.

const fs = require('fs');
const path = require('path');
const { fetchPage, extractPage, phoneOnPages, factSources, keepSourced, doctorEvidence } = require('../lib/outreach/enrich');
const { scoreProspect } = require('../lib/outreach/score');
const { buildCrmNotes } = require('../lib/outreach/crmnotes');
const { registryLookup, registryPrincipals, runOverpass } = require('../lib/outreach/sources');
const { greeting } = require('../lib/outreach/compose');
const { mapLimit, nameKey, stateOf } = require('../lib/outreach/util');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const UNSENT = new Set(['ready', 'queued', 'needs_check', 'no_email', 'skipped']);

// "Lamothe, Michael J" and "Michael Lamothe" are the same person.
function samePerson(a, b) {
  const words = s => nameKey(s).split(' ').filter(w => w.length > 1);
  const A = words(a), B = words(b);
  if (!A.length || !B.length) return false;
  return A[0] === B[0] && A[A.length - 1] === B[B.length - 1]
    || (A.includes(B[0]) && A.includes(B[B.length - 1]));
}

// First and last name close together on the page ("Dr. Susan M. Bowley").
function nameOnPage(name, text) {
  const w = nameKey(name).split(' ').filter(x => x.length > 1 && !/^(dr|mr|mrs|ms|jr|sr|md|dds|dmd)$/.test(x));
  if (w.length < 2) return false;
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc(w[0])}\\b[^a-z]{1,4}(?:[a-z]{1,12}[^a-z]{1,4}){0,2}${esc(w[w.length - 1])}\\b`).test(nameKey(text));
}

async function filingFor(doc) {
  if (doc.registry_id) return { id: doc.registry_id, principals: await registryPrincipals(doc.registry_id) };
  if (stateOf(doc) !== 'CT' && doc.source !== 'registry') return null;
  for (const town of [doc.town, null]) {
    const reg = await registryLookup(doc.name, town);
    if (reg && reg.id) return { id: reg.id, principals: await registryPrincipals(reg.id) };
  }
  return null;
}

// The OpenStreetMap entry a business came from ("node/123"), found again by
// its exact name in its state. With several, the one with the same phone.
async function osmRef(doc) {
  const st = stateOf(doc);
  if (!st || !doc.name) return null;
  const name = String(doc.name).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const q = `[out:json][timeout:25];area["ISO3166-2"="US-${st}"]->.a;nwr["name"="${name}"](area.a);out tags 10;`;
  const res = await runOverpass(q); // a network error fails the business, which is then left as is
  const els = (res && res.elements) || [];
  const digits = x => String(x || '').replace(/\D/g, '').slice(-10);
  const pick = els.length === 1 ? els[0] : els.find(e => doc.phone && digits((e.tags || {}).phone || (e.tags || {})['contact:phone']) === digits(doc.phone));
  return pick ? `${pick.type}/${pick.id}` : null;
}

async function pagesFor(doc) {
  const urls = [...new Set([...((doc.facts || {}).pages_read || []), doc.website].filter(Boolean))].slice(0, 6);
  const out = [];
  for (const u of urls) {
    try { const pg = await fetchPage(u); out.push(extractPage(pg.html, u)); } catch { /* page gone */ }
  }
  return out;
}

async function source(doc, restore) {
  const facts = doc.facts || {};
  const people = (facts.people || []).map(x => ({ ...x }));
  // Names an earlier run dropped by mistake come back and are checked again.
  const back = restore && restore[doc.id];
  if (back) {
    for (const x of back.people) if (!people.some(y => samePerson(y.name, x.name))) people.push({ ...x });
    if (!doc.contact_name && back.contact_name && UNSENT.has(doc.status)) doc = { ...doc, contact_name: back.contact_name, contact_title: back.contact_title, _restored: true };
  }
  if (doc.contact_name && !people.some(x => samePerson(x.name, doc.contact_name))) {
    people.unshift({ name: doc.contact_name, role: (doc.contact_title || '').toLowerCase() || null, how: 'site text' });
  }
  let filing = null;
  // A lookup that errors (network) fails the whole business, so it's left as
  // is rather than losing names we just couldn't check.
  if (people.some(x => x.how === 'state filing' || !x.url)) filing = await filingFor(doc);
  let pages = null;
  const getPages = async () => (pages = pages || await pagesFor(doc));
  for (const x of people) {
    const onFiling = filing && filing.principals.some(pr => samePerson(pr.name, x.name));
    if (x.how === 'state filing') {
      x.business_id = onFiling ? filing.id : null;
      continue;
    }
    if (!x.url) {
      await getPages();
      x.url = (pages.find(pg => nameOnPage(x.name, pg.text)) || {}).url || null;
    }
    // Not on their site, but on the filing: that's the source then.
    if (!x.url && onFiling) { x.how = 'state filing'; x.business_id = filing.id; }
  }
  const kept = people.filter(x => (x.how === 'state filing' ? x.business_id : x.url));
  // "Dr." only with a page that shows it ("Dr. Susan Davis", "Susan Davis, DMD").
  if (kept.length && doc.website && doc.website_verified !== false) {
    const read = await getPages();
    for (const x of kept) {
      const dr = doctorEvidence(x.name, read);
      if (dr) x.doctor_url = dr; else delete x.doctor_url;
    }
  }
  const dropped = people.filter(x => !kept.includes(x)).map(x => x.name);

  const data = { facts: { ...facts, people: kept } };
  if (filing && filing.id !== doc.registry_id) data.registry_id = filing.id;
  let contact = doc.contact_name || null;
  if (contact && !kept.some(x => samePerson(x.name, contact))) contact = null;
  if (doc._restored && contact) { data.contact_name = doc.contact_name; data.contact_title = doc.contact_title; }
  if (contact !== (doc.contact_name || null) && UNSENT.has(doc.status)) {
    const owner = kept.find(x => /owner|founder|president|proprietor|ceo|principal|member|manager|partner/i.test(x.role || '')) || kept[0] || null;
    data.contact_name = owner ? owner.name : null;
    data.contact_title = owner && owner.role ? owner.role.replace(/\b\w/g, c => c.toUpperCase()) : null;
  }
  // The email address and phone number get their sources too.
  if (doc.email && !doc.email_url && doc.email_source === 'website') {
    const hit = (await getPages()).find(pg => (pg.emails || []).includes(doc.email) || String(pg.html || '').toLowerCase().includes(doc.email));
    if (hit) data.email_url = hit.url;
  }
  if (doc.phone && !doc.phone_url) {
    const onSite = phoneOnPages(doc.phone, doc.website ? await getPages() : []);
    const osm = onSite ? null : (doc.source_ref || (doc.source === 'osm' ? await osmRef(doc) : null));
    if (onSite) data.phone_url = onSite;
    else if (osm) { data.phone_url = `https://www.openstreetmap.org/${osm}`; data.source_ref = osm; }
  }
  // A business found on OpenStreetMap: its map entry is the source for its
  // category and address.
  if (doc.source === 'osm' && !doc.source_ref && !data.source_ref) {
    const osm = await osmRef(doc);
    if (osm) data.source_ref = osm;
  }

  // Contact details we can't link to a source are thrown out. A business with
  // no usable email left moves to "No email" so it can't be sent.
  const emailOk = !doc.email || doc.email_source === 'manual'
    || (doc.email_source === 'website' && (doc.email_url || data.email_url))
    || (doc.email_source === 'registry' && (doc.registry_id || data.registry_id))
    || (doc.email_source === 'osm' && (doc.source_ref || data.source_ref));
  const phoneOk = !doc.phone || doc.phone_url || data.phone_url;
  const thrownOut = [];
  // Already emailed: the address stays, since the conversation runs on it.
  if (!emailOk && UNSENT.has(doc.status)) {
    thrownOut.push(`email ${doc.email}`);
    Object.assign(data, { email: null, email_source: null, email_confidence: null, email_url: null });
    if (['ready', 'queued', 'needs_check'].includes(doc.status)) data.status = 'no_email';
  }
  if (!phoneOk) { thrownOut.push(`phone ${doc.phone}`); data.phone = null; }

  // Every fact read off their website keeps the page it's on; the rest go.
  const newFacts = { ...facts, people: kept };
  const siteFacts = ['founded', 'years_claimed', 'family_owned', 'locally_owned', 'team_size_text', 'phone_first', 'quote_requests', 'hiring',
    'paper_forms', 'catering', 'online_ordering', 'has_faq', 'site_year', 'platform', 'description', 'about', 'site_title',
    'booking_tools', 'chat_tools', 'shop_tools', 'big_signals', 'socials'];
  if (siteFacts.some(k => Array.isArray(facts[k]) ? facts[k].length : facts[k] != null && facts[k] !== false)) {
    const read = doc.website && doc.website_verified !== false ? await getPages() : [];
    newFacts.sources = read.length ? factSources(read, doc.bucket, newFacts) : {};
    keepSourced(newFacts);
  }
  const factsChanged = JSON.stringify(newFacts) !== JSON.stringify(facts);
  if (factsChanged) data.facts = newFacts; else delete data.facts;

  const { _restored, ...plain } = doc;
  const next = { ...plain, ...data, facts: newFacts };
  // The score and the class CRM notes only use facts that have a link.
  const scored = scoreProspect(next);
  if (scored.fit_score !== doc.fit_score || JSON.stringify(scored.fit_reasons) !== JSON.stringify(doc.fit_reasons)) Object.assign(data, scored);
  if (doc.crm_org_id) {
    const notes = buildCrmNotes({ ...next, ...scored });
    if (notes !== doc.crm_notes) Object.assign(data, { crm_notes: notes, crm_notes_synced: false });
  }
  if (UNSENT.has(doc.status) && /^Hi [^\n]*,\n/.test(doc.body || '')) {
    const hi = greeting(next);
    const body = doc.body.replace(/^Hi [^\n]*,\n/, `${hi}\n`);
    if (body !== doc.body) data.body = body;
  }
  const changed = data.facts || data.fit_score != null || data.crm_notes || data.registry_id || data.body || 'contact_name' in data || data.email_url || data.phone_url || data.source_ref || thrownOut.length;
  if (!changed) return null;
  const now = new Date().toISOString();
  data.updated_at = now;
  const what = dropped.length
    ? `Names checked against sources; dropped ${dropped.join(', ')} (no source found)`
    : 'Names, email and phone checked against sources: each links to where it was found';
  const log = [{ at: now, what }];
  if (thrownOut.length) log.push({ at: now, what: `Removed ${thrownOut.join(' and ')}: couldn't link it to a source` });
  data.log = [...(doc.log || []), ...log].slice(-40);
  return { id: doc.id, data, dropped, thrownOut };
}

async function main() {
  const dir = arg('docs');
  const outDir = arg('out', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const docs = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { id: f.replace(/\.json$/, ''), ...(j.data || j) }; });
  const restore = arg('restore') ? JSON.parse(fs.readFileSync(arg('restore'), 'utf8')) : null;
  // --only <file>: a JSON list of ids, to finish the ones an earlier run couldn't.
  const only = arg('only') ? new Set(JSON.parse(fs.readFileSync(arg('only'), 'utf8'))) : null;
  const todo = only ? docs.filter(d => only.has(d.id)) : docs;
  console.log(`Checking every fact on ${todo.length} businesses against its source`);
  let i = 0;
  const updates = (await mapLimit(todo, 4, async d => {
    try {
      const u = await source(d, restore);
      console.log(`  [${++i}/${todo.length}] ${d.name}: ${u ? [u.dropped.length ? `dropped ${u.dropped.join(', ')}` : 'sources added', ...u.thrownOut.map(x => `removed ${x}`)].join('; ') : 'already sourced'}`);
      return u;
    } catch (err) {
      console.log(`  [${++i}/${todo.length}] ${d.name}: failed (${err.message}); left as is`);
      return null;
    }
  })).filter(Boolean);
  fs.writeFileSync(path.join(outDir, 'sources.json'), JSON.stringify(updates.map(({ id, data }) => ({ id, data })), null, 2));
  const dropped = updates.filter(u => u.dropped.length);
  const emails = updates.filter(u => u.thrownOut.some(x => x.startsWith('email'))).length;
  const phones = updates.filter(u => u.thrownOut.some(x => x.startsWith('phone'))).length;
  console.log(`${updates.length} updated; ${dropped.length} had a name with no source (dropped); ${emails} emails and ${phones} phone numbers removed for having no source. Wrote ${path.join(outDir, 'sources.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
