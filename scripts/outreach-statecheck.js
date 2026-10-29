#!/usr/bin/env node
// One-off check: which businesses on the Outreach Desk are actually outside
// Connecticut? The CT registry also lists out-of-state companies registered
// to do business here, and their towns share names with ours (Mansfield MA
// and TX, Coventry RI, Windham NH/ME). Looks up each registry business's
// filed address state and writes patches that record the real state:
// Boston, New York and New England stay in (the class's area), anywhere
// else stays on the desk only and leaves the class CRM.
//
//   node scripts/outreach-statecheck.js --in desk-dir --out out
//
// desk-dir holds one <id>.json per desk document (ArtifactData list with
// out_dir). Writes out/statecheck.json: [{ id, state, address, data }] for
// every business outside CT, where data is the ArtifactData update.

const fs = require('node:fs');
const path = require('node:path');
const { registryColumns, socrata, soqlString, rowToRegistry, REGISTRY_MASTER } = require('../lib/outreach/sources');
const { buildCrmNotes, hasSubstance } = require('../lib/outreach/crmnotes');
const { composeInitial } = require('../lib/outreach/compose');
const { DEFAULT_SETTINGS } = require('../lib/outreach/settings');
const { nameKey, inClassArea } = require('../lib/outreach/util');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

async function main() {
  const dir = arg('in');
  const outDir = arg('out', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const docs = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({ id: f.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  const c = await registryColumns();
  if (!c.state || !c.city) throw new Error(`Registry state/id columns not detected: ${JSON.stringify(c)}`);
  console.log(`Registry columns: name=${c.name} state=${c.state} city=${c.city} street=${c.street}`);

  // Every registry business in our towns whose filed address isn't in CT.
  const towns = [...new Set(docs.map(d => String(d.town || '').toUpperCase()).filter(Boolean))];
  const rows = await socrata(REGISTRY_MASTER, {
    $where: `upper(${c.city}) in (${towns.map(soqlString).join(',')}) AND ${c.state} IS NOT NULL AND upper(${c.state}) not in ('CT', 'CONNECTICUT')`,
    $limit: '50000',
  });
  const away = new Map();
  for (const r of rows) { const reg = rowToRegistry(r, c); if (reg.name) away.set(`${nameKey(reg.name)}|${String(reg.city || '').toUpperCase()}`, reg); }
  console.log(`${rows.length} out-of-state registry entries in ${towns.join(', ')}`);

  const out = [];
  for (const d of docs) {
    const reg = away.get(`${nameKey(d.name)}|${String(d.town || '').toUpperCase()}`);
    if (!reg) continue;
    const state = String(reg.state).trim().toUpperCase().replace(/^MASSACHUSETTS$/, 'MA').replace(/^RHODE ISLAND$/, 'RI').replace(/^NEW YORK$/, 'NY').replace(/^TEXAS$/, 'TX');
    const where = `${[reg.street, reg.city].filter(Boolean).join(', ')}, ${state}`;
    const fixed = { ...d, state, address: [reg.street, reg.city].filter(Boolean).join(', ') };
    const draft = d.email && ['ready', 'queued'].includes(d.status) ? composeInitial(fixed, DEFAULT_SETTINGS) : null;
    const data = {
      state, address: fixed.address,
      crm_ok: hasSubstance(fixed) && inClassArea(fixed),
      crm_notes: buildCrmNotes(fixed), crm_notes_synced: false,
      ...(draft ? { subject: draft.subject, body: draft.body } : {}),
      updated_at: new Date().toISOString(),
    };
    out.push({ id: d.id, name: d.name, status: d.status, state, address: where, data });
    console.log(`  ${state}: ${d.name} — ${where}${inClassArea(fixed) ? '' : ' (outside the class area: desk only)'}`);
  }
  fs.writeFileSync(path.join(outDir, 'statecheck.json'), JSON.stringify(out, null, 2));
  console.log(`${out.length} out of state. Wrote ${path.join(outDir, 'statecheck.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
