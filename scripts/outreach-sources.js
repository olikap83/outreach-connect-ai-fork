// Gives every name on the desk a source: the CT filing that lists the person
// (by the business's filing id) or the page of their website the name is on.
// A name we can't point back to a source is dropped; if it was the contact,
// the draft's greeting falls back to the people on the filing, or the team.
//
//   node scripts/outreach-sources.js --docs <dir of prospect JSON files> --out out
//
// Writes out/sources.json: [{ id, data }] updates to apply.

const fs = require('fs');
const path = require('path');
const { fetchPage, extractPage } = require('../lib/outreach/enrich');
const { registryLookup, registryPrincipals } = require('../lib/outreach/sources');
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

async function pagesFor(doc) {
  const urls = [...new Set([...((doc.facts || {}).pages_read || []), doc.website].filter(Boolean))].slice(0, 6);
  const out = [];
  for (const u of urls) {
    try { const pg = await fetchPage(u); out.push(extractPage(pg.html, u)); } catch { /* page gone */ }
  }
  return out;
}

async function source(doc) {
  const facts = doc.facts || {};
  const people = (facts.people || []).map(x => ({ ...x }));
  if (doc.contact_name && !people.some(x => samePerson(x.name, doc.contact_name))) {
    people.unshift({ name: doc.contact_name, role: (doc.contact_title || '').toLowerCase() || null, how: 'site text' });
  }
  if (!people.length) return null;

  let filing = null;
  // A lookup that errors (network) fails the whole business, so it's left as
  // is rather than losing names we just couldn't check.
  if (people.some(x => x.how === 'state filing' || !x.url)) filing = await filingFor(doc);
  let pages = null;
  for (const x of people) {
    const onFiling = filing && filing.principals.some(pr => samePerson(pr.name, x.name));
    if (x.how === 'state filing') {
      x.business_id = onFiling ? filing.id : null;
      continue;
    }
    if (!x.url) {
      pages = pages || await pagesFor(doc);
      x.url = (pages.find(pg => nameOnPage(x.name, pg.text)) || {}).url || null;
    }
    // Not on their site, but on the filing: that's the source then.
    if (!x.url && onFiling) { x.how = 'state filing'; x.business_id = filing.id; }
  }
  const kept = people.filter(x => (x.how === 'state filing' ? x.business_id : x.url));
  const dropped = people.filter(x => !kept.includes(x)).map(x => x.name);

  const data = { facts: { ...facts, people: kept } };
  if (filing && filing.id !== doc.registry_id) data.registry_id = filing.id;
  let contact = doc.contact_name || null;
  if (contact && !kept.some(x => samePerson(x.name, contact))) contact = null;
  if (contact !== (doc.contact_name || null) && UNSENT.has(doc.status)) {
    const owner = kept.find(x => /owner|founder|president|proprietor|ceo|principal|member|manager|partner/i.test(x.role || '')) || kept[0] || null;
    data.contact_name = owner ? owner.name : null;
    data.contact_title = owner && owner.role ? owner.role.replace(/\b\w/g, c => c.toUpperCase()) : null;
  }
  const next = { ...doc, ...data };
  if (UNSENT.has(doc.status) && /^Hi [^\n]*,\n/.test(doc.body || '')) {
    const hi = greeting(next);
    const body = doc.body.replace(/^Hi [^\n]*,\n/, `${hi}\n`);
    if (body !== doc.body) data.body = body;
  }
  const changed = JSON.stringify(kept) !== JSON.stringify(facts.people || []) || data.registry_id || data.body || 'contact_name' in data;
  if (!changed) return null;
  const now = new Date().toISOString();
  data.updated_at = now;
  const what = dropped.length
    ? `Names checked against sources; dropped ${dropped.join(', ')} (no source found)`
    : 'Names checked against sources: each links to where it was found';
  data.log = [...(doc.log || []), { at: now, what }].slice(-40);
  return { id: doc.id, data, dropped };
}

async function main() {
  const dir = arg('docs');
  const outDir = arg('out', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const docs = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { id: f.replace(/\.json$/, ''), ...(j.data || j) }; });
  const todo = docs.filter(d => d.contact_name || ((d.facts || {}).people || []).length);
  console.log(`Checking names on ${todo.length} businesses`);
  let i = 0;
  const updates = (await mapLimit(todo, 4, async d => {
    try {
      const u = await source(d);
      console.log(`  [${++i}/${todo.length}] ${d.name}: ${u ? (u.dropped.length ? `dropped ${u.dropped.join(', ')}` : 'sources added') : 'already sourced'}`);
      return u;
    } catch (err) {
      console.log(`  [${++i}/${todo.length}] ${d.name}: failed (${err.message}); left as is`);
      return null;
    }
  })).filter(Boolean);
  fs.writeFileSync(path.join(outDir, 'sources.json'), JSON.stringify(updates.map(({ id, data }) => ({ id, data })), null, 2));
  const dropped = updates.filter(u => u.dropped.length);
  console.log(`${updates.length} updated; ${dropped.length} had a name with no source (dropped). Wrote ${path.join(outDir, 'sources.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
