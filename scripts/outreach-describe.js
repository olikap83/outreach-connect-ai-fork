#!/usr/bin/env node
// Backfill: re-research businesses already on the Outreach Desk so their
// class CRM entries can say something real (what they do, size, website).
// Keeps each business's chosen email and contact as they are; only adds
// what's learned about the business itself.
//
//   node scripts/outreach-describe.js --in desk-dir --out out [--start 0 --count 20] [--settings <settings JSON file>]
//
// desk-dir holds one <id>.json per desk document, as ArtifactData `list`
// with out_dir saves them. Writes out/describe-<start>.json: an array of
// { id, version, data } patches ready for an ArtifactData batch update.

const fs = require('node:fs');
const path = require('node:path');
const { enrichProspect } = require('../lib/outreach/enrich');
const { buildCrmNotes, hasSubstance } = require('../lib/outreach/crmnotes');
const { loadSettings } = require('../lib/outreach/settings');
const { mapLimit } = require('../lib/outreach/util');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const SETTINGS = loadSettings(arg('settings'));

const KEEP_FACTS = ['website_unverified', 'about', 'description', 'naics', 'business_type', 'team_size_text', 'founded', 'years_claimed', 'registered_year',
  'family_owned', 'locally_owned', 'phone_first', 'quote_requests', 'paper_forms', 'hiring', 'catering', 'booking_tools', 'shop_tools',
  'chat_tools', 'platform', 'site_year', 'socials', 'pages_read'];

async function main() {
  const dir = arg('in');
  const outDir = arg('out', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const all = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { id: f.replace(/\.json$/, ''), version: raw.version, doc: raw.data || raw };
  });
  const start = Number(arg('start', 0));
  const count = Number(arg('count', all.length));
  const slice = all.slice(start, start + count);

  let i = 0;
  const patches = (await mapLimit(slice, 4, async ({ id, version, doc }) => {
    const p = { ...doc, id };
    let facts = { ...(doc.facts || {}) };
    let website = doc.website || null;
    let domain = doc.domain || null;
    let verified = false;
    try {
      const patch = await enrichProspect(p);
      // Only keep a website the research actually loaded and matched to this business.
      if (patch.website_verified) { website = patch.website || website; domain = patch.domain || domain; verified = true; }
      else if (website) { facts.website_unverified = website; website = null; domain = null; }
      for (const k of KEEP_FACTS) {
        const v = patch.facts && patch.facts[k];
        if (v != null && !(Array.isArray(v) && !v.length) && v !== false) facts[k] = v;
      }
    } catch (err) {
      facts.enrich_notes = [...(facts.enrich_notes || []), `Re-research failed: ${err.message}`];
    }
    const merged = { ...p, website, domain, facts };
    const data = { website, domain, website_verified: verified && !!website, facts, crm_ok: hasSubstance(merged), crm_notes: buildCrmNotes(merged, SETTINGS), crm_notes_synced: false, updated_at: new Date().toISOString() };
    console.log(`  [${++i}/${slice.length}] ${doc.name}: ${website ? domain : 'no website'}${facts.about || facts.description ? ', described' : ''}${data.crm_ok ? '' : ', NOT for CRM'}`);
    return { id, version, data };
  }));

  const file = path.join(outDir, `describe-${start}.json`);
  fs.writeFileSync(file, JSON.stringify(patches, null, 2));
  console.log(`Wrote ${patches.length} patches → ${file} (${patches.filter(x => x.data.crm_ok).length} fit for the CRM, ${patches.filter(x => x.data.website).length} with websites)`);
}

main().catch(err => { console.error(err); process.exit(1); });
