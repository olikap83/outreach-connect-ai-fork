#!/usr/bin/env node
// Research for the Outreach Desk (claude.ai artifact). Claude runs this and
// writes the output into the page's database with ArtifactData. It works in
// two steps so businesses can land on the desk a few at a time:
//
//   1. node scripts/outreach-batch.js --find --known known.json --out out [--towns 2] [--max 40] [--town Mansfield] [--places '*, TX|*, CA']
//        finds businesses (no website reading yet) → out/candidates.json, out/summary.json
//   2. node scripts/outreach-batch.js --research --start 0 --count 5 --out out
//        reads those businesses' websites, scores them, writes drafts → out/docs-<start>.json
//      Repeat with --start 5, 10, ... until --start reaches the candidate count.
//
// With neither flag it does both in one go (out/prospects.json).
//
// known.json: { "names": ["Business Name", ...], "towns_done": {"Mansfield": "2026-10-29T..."}, "settings": {...} }
//   names = everything already in the class CRM + already on the desk, so
//   nobody gets researched (or emailed) twice.
// Nothing is sent and nothing outside this machine is written: sending
// happens only when Soham approves on the desk.

const fs = require('node:fs');
const path = require('node:path');
const { sourceTownFromOsm, sourceTownFromRegistry } = require('../lib/outreach/sources');
const { enrichProspect } = require('../lib/outreach/enrich');
const { scoreProspect } = require('../lib/outreach/score');
const { composeInitial } = require('../lib/outreach/compose');
const { buildCrmNotes, hasSubstance, cardLine } = require('../lib/outreach/crmnotes');
const { mergeSettings } = require('../lib/outreach/settings');
const { readinessProblems } = require('../lib/outreach/verify');
const { nameKey, mapLimit, stateOf, inClassArea, parsePlace } = require('../lib/outreach/util');

const TOWNS = [
  'Mansfield', 'Windham', 'Coventry', 'Tolland', 'Vernon', 'Manchester', 'Ellington', 'Stafford', 'Willington', 'Ashford',
  'Columbia', 'Hebron', 'Lebanon', 'Bolton', 'Andover', 'Glastonbury', 'South Windsor', 'East Hartford', 'Norwich', 'Colchester',
  'Enfield', 'Somers', 'East Windsor', 'Windsor', 'Killingly', 'Putnam', 'Plainfield', 'Brooklyn', 'Pomfret', 'Woodstock',
  'Thompson', 'Hartford', 'West Hartford', 'Wethersfield', 'Rocky Hill', 'Middletown',
  // The rest of the class's area: Boston, New York and New England.
  'Boston, MA', 'Cambridge, MA', 'Somerville, MA', 'Worcester, MA', 'Springfield, MA', 'Mansfield, MA', 'Providence, RI',
  'Warwick, RI', 'Coventry, RI', 'Manhattan, NY', 'Brooklyn, NY', 'Queens, NY', 'Portsmouth, NH', 'Manchester, NH',
  'Burlington, VT', 'Portland, ME',
  // Then the rest of the country, a major city or two per state, searched on
  // OpenStreetMap for real local businesses. (Whole-state registry lists,
  // "*, TX", still work with --places but turned up mostly big multi-state
  // companies with back-office emails.) Outside the class's area these stay
  // on Soham's desk and never go to the class CRM.
  'Birmingham, AL', 'Anchorage, AK', 'Phoenix, AZ', 'Little Rock, AR', 'Los Angeles, CA', 'San Francisco, CA', 'Denver, CO',
  'Wilmington, DE', 'Washington, DC', 'Miami, FL', 'Tampa, FL', 'Atlanta, GA', 'Honolulu, HI', 'Boise, ID', 'Chicago, IL',
  'Indianapolis, IN', 'Des Moines, IA', 'Wichita, KS', 'Louisville, KY', 'New Orleans, LA', 'Baltimore, MD', 'Detroit, MI',
  'Minneapolis, MN', 'Jackson, MS', 'St. Louis, MO', 'Billings, MT', 'Omaha, NE', 'Las Vegas, NV', 'Newark, NJ', 'Jersey City, NJ',
  'Albuquerque, NM', 'Charlotte, NC', 'Fargo, ND', 'Columbus, OH', 'Oklahoma City, OK', 'Portland, OR', 'Philadelphia, PA',
  'Pittsburgh, PA', 'Charleston, SC', 'Sioux Falls, SD', 'Nashville, TN', 'Austin, TX', 'Houston, TX', 'Salt Lake City, UT',
  'Richmond, VA', 'Seattle, WA', 'Charleston, WV', 'Milwaukee, WI', 'Cheyenne, WY',
];

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

// CT businesses keep their original ids ("name-town"); elsewhere the state is added.
const docId = p => `${nameKey(p.name)}-${String(p.town || 'ct').toLowerCase()}${stateOf(p) === 'CT' ? '' : `-${stateOf(p).toLowerCase()}`}`.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);

async function findCandidates({ known, outDir, maxTowns, max, settings }) {
  const seen = new Set((known.names || []).map(nameKey));
  const done = known.towns_done || {};
  // --places 'Boston, MA|*, TX|*, CA' searches exactly those places (| separated).
  const towns = arg('places') ? arg('places').split('|').map(x => x.trim()).filter(Boolean) : arg('town') ? [arg('town')] : TOWNS.slice().sort((a, b) => String(done[a] || '').localeCompare(String(done[b] || ''))).slice(0, maxTowns);
  const summary = { at: new Date().toISOString(), towns: {}, errors: [] };
  let found = [];
  // --pause <seconds> between places: the free OpenStreetMap mirrors return
  // 503/504 when hit with city after city back to back.
  const pause = Number(arg('pause', 0)) * 1000;
  for (const [ti, town] of towns.entries()) {
    if (pause && ti) await new Promise(r => setTimeout(r, pause));
    let n = 0;
    // --osm-only skips the CT registry (out-of-state entries there are mostly big multi-state companies).
    // Outside CT the registry only has companies that also filed in CT, mostly big multi-state ones.
    const useRegistry = !process.argv.includes('--osm-only') && parsePlace(town).state === 'CT';
    for (const [label, fn] of [['OpenStreetMap', sourceTownFromOsm], ...(useRegistry ? [['CT registry', sourceTownFromRegistry]] : [])]) {
      try {
        for (const p of await fn(town)) {
          if (seen.has(p.name_key)) continue;
          // The distance limit is for CT; Boston and New York are far on purpose.
          if (stateOf(p) === 'CT' && p.miles_from_storrs != null && p.miles_from_storrs > settings.max_miles) continue;
          seen.add(p.name_key);
          p._place = town;
          found.push(p);
          n++;
        }
      } catch (err) {
        summary.errors.push(`${town} · ${label}: ${err.message}`);
      }
    }
    summary.towns[town] = n;
    console.log(`${town}: ${n} new businesses`);
  }
  // Closest first within each place; across places take turns, so a run
  // over many places (say all 50 states) researches a few from each.
  found.sort((a, b) => (a.miles_from_storrs ?? 99) - (b.miles_from_storrs ?? 99));
  const byPlace = new Map();
  for (const p of found) { if (!byPlace.has(p._place)) byPlace.set(p._place, []); byPlace.get(p._place).push(p); }
  const queues = [...byPlace.values()];
  found = [];
  while (queues.some(q => q.length)) for (const q of queues) if (q.length) found.push(q.shift());
  const all = found;
  found = found.slice(0, max);
  summary.candidates = found.length;
  // A town only counts as done once everything found there is researched;
  // otherwise the next run picks it up again and continues where this left off.
  // A place whose search failed (0 found plus an error) isn't done either.
  const failed = t => summary.towns[t] === 0 && summary.errors.some(e => e.startsWith(`${t} · `));
  summary.towns_complete = Object.keys(summary.towns).filter(t => !failed(t) && !all.slice(max).some(p => p._place === t));
  summary.left_over = Math.max(0, all.length - found.length);
  fs.writeFileSync(path.join(outDir, 'candidates.json'), JSON.stringify({ settings, candidates: found }, null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return { found, summary };
}

async function research(list, settings, errors) {
  let i = 0;
  return (await mapLimit(list, 4, async p => {
    try {
      const doc = await toDoc(p, settings);
      console.log(`  [${++i}/${list.length}] ${p.name}: ${doc.email ? `fit ${doc.fit_score}, ${doc.email}` : 'no email found'}`);
      return doc;
    } catch (err) {
      errors.push(`${p.name}: ${err.message}`);
      console.log(`  [${++i}/${list.length}] ${p.name}: failed (${err.message})`);
      return null;
    }
  })).filter(Boolean);
}

async function toDoc(p, settings) {
  const patch = await enrichProspect(p);
  const merged = { ...p, ...patch };
  // Anything uncertain goes to "Needs a look" instead of the review list.
  const problems = merged.email ? readinessProblems(merged) : [];
  Object.assign(merged, scoreProspect(merged));
  const draft = merged.email ? composeInitial({ ...merged, id: docId(merged) }, settings) : null;
  const f = merged.facts || {};
  const now = new Date().toISOString();
  return {
    id: docId(merged),
    name: merged.name, category: merged.category || null, bucket: merged.bucket || null,
    town: merged.town || null, state: stateOf(merged), address: merged.address || null, phone: merged.phone || null,
    website: merged.website || null, domain: merged.domain || null, website_verified: !!merged.website_verified,
    miles_from_storrs: merged.miles_from_storrs ?? null,
    contact_name: merged.contact_name || null, contact_title: merged.contact_title || null,
    email: merged.email || null, email_source: merged.email_source || null, email_confidence: merged.email_confidence || null,
    fit_score: merged.fit_score, fit_reasons: merged.fit_reasons,
    facts: {
      founded: f.founded || null, years_claimed: f.years_claimed || null, family_owned: !!f.family_owned, locally_owned: !!f.locally_owned,
      team_size_text: f.team_size_text || null, phone_first: !!f.phone_first, quote_requests: !!f.quote_requests, paper_forms: !!f.paper_forms,
      hiring: !!f.hiring, catering: !!f.catering, booking_tools: f.booking_tools || [], shop_tools: f.shop_tools || [], chat_tools: f.chat_tools || [],
      platform: f.platform || null, site_year: f.site_year || null, registered_year: f.registered_year || null, socials: f.socials || [],
      description: f.description || null, about: f.about || null, naics: f.naics || null, business_type: f.business_type || null,
      people: f.people || [], emails_found: f.emails_found || [], pages_read: f.pages_read || [],
      enrich_notes: f.enrich_notes || [], website_unverified: f.website_unverified || null,
    },
    source: merged.source,
    // The CT filing this business's details came from, so the desk can link to it.
    registry_id: merged.registry?.id || null,
    crm_ok: hasSubstance(merged) && inClassArea(merged),
    crm_notes: buildCrmNotes(merged),
    card_line: cardLine(merged),
    status: !merged.email ? 'no_email' : problems.length ? 'needs_check' : 'ready',
    check_problems: problems,
    subject: draft ? draft.subject : null,
    body: draft ? draft.body : null,
    created_at: now,
    updated_at: now,
    log: [{ at: now, what: !merged.email ? 'Researched: no email address found' : problems.length ? `Researched: needs a look (${problems[0]})` : `Researched: fit ${merged.fit_score}/100, draft ready` }],
  };
}

async function main() {
  const outDir = arg('out', 'out');
  fs.mkdirSync(outDir, { recursive: true });

  if (process.argv.includes('--research')) {
    const { settings, candidates } = JSON.parse(fs.readFileSync(path.join(outDir, 'candidates.json'), 'utf8'));
    const start = Number(arg('start', 0));
    const count = Number(arg('count', 5));
    const slice = candidates.slice(start, start + count);
    const errors = [];
    const docs = await research(slice, mergeSettings(settings), errors);
    fs.writeFileSync(path.join(outDir, `docs-${start}.json`), JSON.stringify(docs, null, 2));
    const ready = docs.filter(d => d.status === 'ready').length;
    console.log(`Researched ${Math.min(start + count, candidates.length)} of ${candidates.length}: this chunk ${docs.length} businesses, ${ready} drafts ready → ${path.join(outDir, `docs-${start}.json`)}`);
    if (errors.length) console.log(`Problems:\n- ${errors.join('\n- ')}`);
    return;
  }

  const known = JSON.parse(fs.readFileSync(arg('known'), 'utf8'));
  const settings = mergeSettings(known.settings || {});
  const { found, summary } = await findCandidates({ known, outDir, maxTowns: Number(arg('towns', 2)), max: Number(arg('max', 40)), settings });

  if (process.argv.includes('--find')) {
    console.log(`Found ${found.length} businesses to research${summary.left_over ? ` (${summary.left_over} more left for the next run)` : ''} → ${path.join(outDir, 'candidates.json')}`);
    console.log(`Towns fully covered this run: ${summary.towns_complete.join(', ') || 'none yet'}`);
    if (summary.errors.length) console.log(`Problems:\n- ${summary.errors.join('\n- ')}`);
    return;
  }

  const docs = await research(found, settings, summary.errors);
  docs.sort((a, b) => b.fit_score - a.fit_score);
  summary.researched = docs.length;
  summary.ready = docs.filter(d => d.status === 'ready').length;
  summary.text = `${Object.entries(summary.towns).map(([t, n]) => `${t} (${n} new)`).join(', ') || 'No towns'}: researched ${docs.length}, ${summary.ready} drafts ready`;
  fs.writeFileSync(path.join(outDir, 'prospects.json'), JSON.stringify(docs, null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(summary.text);
  if (summary.errors.length) console.log(`Problems:\n- ${summary.errors.slice(0, 20).join('\n- ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
