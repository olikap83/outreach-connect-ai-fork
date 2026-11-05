// The last check before an email goes out on its own, without you reading
// it first. For each draft it re-reads the business's website (and the CT
// filing when that's where the business came from) and proves, with a link,
// everything the email relies on:
//
//   - the email address: found again on their site or in their filing
//   - the name in "Hi <name>": found again, and not at odds with the address
//     (no "Hi Steve" to barry@...); otherwise the team greeting
//   - each detail in the email (since 2018, family-owned...): found again;
//     anything that isn't is dropped and the email is rewritten without it
//   - the business itself: still small, still in the right place
//
// What passes is queued with its proof (preflight.checks, each with a link);
// what doesn't goes to "Needs a look" with the reason. Drafts you edited by
// hand keep your wording: if a detail in them no longer checks out, they wait
// for you instead of being rewritten. Drafts are written from your settings.
//
//   node scripts/outreach-preflight.js --docs <dir of prospect JSON files> --out <dir> [--max 30] [--settings <settings JSON file>]
//     → <out>/plan.json: [{ id, file, result: "queued"|"needs_check", reason }]
//       and <out>/updates/<id>.json, the desk update for each.

const fs = require('fs');
const path = require('path');
const { enrichProspect } = require('../lib/outreach/enrich');
const { registryLookup } = require('../lib/outreach/sources');
const { readinessProblems } = require('../lib/outreach/verify');
const { composeInitial, greeting } = require('../lib/outreach/compose');
const { sourceUrl, samePerson, confirmName } = require('../lib/outreach/factsources');
const { loadSettings } = require('../lib/outreach/settings');
const { mapLimit, stateOf, stateCode } = require('../lib/outreach/util');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const PUT_DOWN = /\b(big chains|big-box|dealerships|stay competitive|compete with|against the (big|larger)|big-company)\b/i;
const HAND_EDITED = /^(Edited the draft|Saved as a Gmail draft)/;
const GENERIC_LOCAL = /^(info|office|contact|hello|hi|admin|sales|support|team|shop|store|mail|email|inquiries|inquiry|booking|bookings|appointments|service|frontdesk|reception|orders|help|marketing|general|main|business|manager|owner)\d*$/;

// "Hi Steve" to barry@...: the address points at someone else.
function nameFitsAddress(name, email) {
  if (!name || !email) return true;
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!local || GENERIC_LOCAL.test(local)) return true;
  const parts = String(name).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !/^(dr|mr|mrs|ms|jr|sr)$/.test(w));
  if (!parts.length) return true;
  const first = parts[0], last = parts[parts.length - 1];
  // jenn@ for Jennifer, ksantiago@ / kts.santiago@ for Karen Santiago, stephenbradway69@ ...
  if (local.includes(last) || local.startsWith(first.slice(0, 3)) || first.startsWith(local.slice(0, 3))) return true;
  // Initials-only or very short locals (jd@, kts@) can't be judged.
  return local.length <= 3;
}

// The details composeInitial can use, as fact keys.
const DETAIL_KEYS = ['founded', 'years_claimed', 'family_owned', 'locally_owned'];
const mentions = (body, key, f) => ({
  founded: f.founded && body.includes(String(f.founded)),
  years_claimed: f.years_claimed && new RegExp(`${f.years_claimed}\\s*(\\+|years)`).test(body),
  family_owned: /family business|family-owned|family owned/i.test(body),
  locally_owned: /locally owned/i.test(body),
}[key]);

async function preflight(doc, settings) {
  const now = new Date().toISOString();
  const p = {
    id: doc.id, name: doc.name, town: doc.town, state: stateOf(doc), source: doc.source, bucket: doc.bucket, category: doc.category,
    website: doc.website || null, domain: doc.domain || null, email: doc.email, email_source: doc.email_source,
    contact_name: doc.contact_name, registry_id: doc.registry_id, source_ref: doc.source_ref, facts: {},
  };
  const problems = [];
  const checks = [];
  if (doc.source === 'registry') {
    const reg = await registryLookup(doc.name, null).catch(() => null);
    if (reg) {
      p.registry = reg;
      if (reg.location_from === 'office' && (String(reg.city || '').toLowerCase() !== String(doc.town || '').toLowerCase() || stateCode(reg.state || '') !== stateOf(doc))) {
        problems.push(`The state filing puts the business in ${reg.city || '?'}, ${stateCode(reg.state || '') || '?'}, not ${doc.town}, ${stateOf(doc)}.`);
      }
    }
  }
  const fresh = { ...p, ...(await enrichProspect(p, { findWebsite: false })) };
  const f = fresh.facts || {};
  // Nothing loaded means nothing proven: leave it for a run that can reach the site.
  const readSite = (f.pages_read || []).length > 0;
  const readFiling = !!p.registry;
  if (doc.website && !readSite && !readFiling) throw new Error(`couldn't load ${doc.website}`);
  if (!doc.website && !readFiling && doc.email_source !== 'osm') throw new Error('nothing to check against');
  if (doc.email_source === 'website' && !readSite) throw new Error(`couldn't load ${doc.website} to find the email again`);
  if (doc.email_source === 'registry' && !readFiling) throw new Error("couldn't load the CT filing");

  // The address.
  if (!doc.email) problems.push('No email address.');
  else if (fresh.email !== doc.email) problems.push(`${doc.email} wasn't found again on their website or filing.`);
  else {
    const url = sourceUrl(fresh, 'email');
    if (url) checks.push({ what: `Email ${doc.email}`, url });
    else problems.push(`${doc.email} has no page we can link to as proof.`);
  }

  // The name in the greeting.
  let contact = fresh.contact_name || null;
  if (doc.contact_name && !samePerson(doc.contact_name, contact || '')) contact = null; // the name we had wasn't found again
  if (contact && !nameFitsAddress(contact, doc.email)) contact = null;
  const confirmed = contact ? confirmName({ ...fresh, email: doc.email }, contact) : null;
  if (contact && !confirmed) contact = null;
  if (contact) checks.push({ what: `Name ${contact} (${confirmed.how})`, url: confirmed.url });

  problems.push(...readinessProblems({ ...fresh, email: doc.email }));

  const next = { ...doc, ...fresh, email: doc.email, contact_name: contact, facts: { ...f } };
  const handEdited = (doc.log || []).some(l => HAND_EDITED.test(l.what || ''));
  let { subject, body } = { subject: doc.subject, body: doc.body };
  if (handEdited) {
    // Your wording stays. Any detail it mentions has to check out again.
    const old = doc.facts || {};
    for (const key of DETAIL_KEYS) {
      if (!old[key] || !mentions(doc.body || '', key, old)) continue;
      if (f[key] !== old[key] || !sourceUrl(next, key)) problems.push(`Your edited draft mentions "${key.replace('_', ' ')}", which wasn't found again on their site.`);
    }
    const greet = (/^Hi ([^\n,]+),/.exec(doc.body || '') || [])[1] || '';
    if (greet && !/team$/i.test(greet) && !contact) problems.push(`Your edited draft says "Hi ${greet}", but that name wasn't found again or doesn't match ${doc.email}.`);
  } else {
    ({ subject, body } = composeInitial(next, settings));
  }
  for (const key of DETAIL_KEYS) {
    if (next.facts[key] && mentions(body, key, next.facts) && !handEdited) {
      const url = sourceUrl(next, key);
      if (url) checks.push({ what: key === 'founded' ? `In business since ${next.facts.founded}` : key.replace('_', ' '), url });
    }
  }
  if (/hi there/i.test(body) || !/^Hi [^\n]+,/.test(body)) problems.push('The greeting is missing or generic.');
  // The rule: never set them against bigger companies or competitors.
  if (PUT_DOWN.test(body)) problems.push('The email compares them to big chains or competitors, which reads as a put-down.');
  // A name in the greeting has to be someone we can link to: the proven
  // contact, or a person on the state filing.
  const greetName = ((/^Hi ([^\n,]+),/.exec(body) || [])[1] || '').replace(/^Dr\.\s+/, '');
  if (greetName && !/ team$/.test(greetName) && !contact) {
    const filed = ((next.facts || {}).people || []).find(x => x.how === 'state filing' && String(x.name || '').toLowerCase().split(/\s+/).some(w => w.startsWith(greetName.toLowerCase().slice(0, 3))));
    const ok = filed ? confirmName(next, filed.name) : null;
    if (ok) checks.push({ what: `Name ${filed.name} (${ok.how})`, url: ok.url });
    else problems.push(`The email says "Hi ${greetName}", but that name can't be linked to their website or filing.`);
  }

  const log = what => [...(doc.log || []), { at: now, what }].slice(-40);
  if (problems.length) {
    return { id: doc.id, result: 'needs_check', reason: problems[0], data: {
      status: 'needs_check', check_problems: [...new Set(problems)], check_reason: problems[0], updated_at: now,
      log: log(`Held back by the pre-send check: ${problems[0]}`) } };
  }
  const data = {
    status: 'queued', queued_by: 'preflight', subject, body, contact_name: contact, facts: next.facts,
    email_url: fresh.email_url ?? doc.email_url ?? null, preflight: { at: now, checks }, updated_at: now,
    log: log(`Checked against their website and approved to send (${checks.length} thing${checks.length === 1 ? '' : 's'} proven with links)`),
  };
  return { id: doc.id, result: 'queued', reason: null, data };
}

async function main() {
  const dir = arg('docs');
  const out = arg('out', 'out/preflight');
  const max = Number(arg('max', 30));
  const settings = loadSettings(arg('settings'));
  const docs = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { id: f.replace(/\.json$/, ''), ...(j.data || j) }; })
    .filter(d => d.status === 'ready' && d.email)
    .sort((a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0));
  fs.mkdirSync(path.join(out, 'updates'), { recursive: true });
  // Check a few extra, since some won't pass.
  const pool = docs.slice(0, Math.ceil(max * 1.5));
  let queued = 0;
  const results = [];
  await mapLimit(pool, 4, async d => {
    if (queued >= max) return;
    try {
      const r = await preflight(d, settings);
      if (r.result === 'queued') { if (queued >= max) return; queued++; }
      results.push(r);
      console.log(`  ${d.name}: ${r.result === 'queued' ? 'ok' : `held back (${r.reason})`}`);
    } catch (e) {
      console.log(`  ${d.name}: couldn't check (${e.message}); left for later`);
    }
  });
  const plan = results.map(r => {
    const file = path.resolve(out, 'updates', `${r.id}.json`);
    fs.writeFileSync(file, JSON.stringify(r.data));
    return { id: r.id, file, result: r.result, reason: r.reason };
  });
  fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(plan, null, 2));
  console.log(`${plan.filter(r => r.result === 'queued').length} approved to send, ${plan.filter(r => r.result !== 'queued').length} held back. Wrote ${path.join(out, 'plan.json')}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { preflight, nameFitsAddress, PUT_DOWN };
