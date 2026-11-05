// Rewrites drafts already on the desk in the current email format, leaving
// alone any draft you edited yourself. No network needed.
//
//   node scripts/outreach-redraft.js --docs <dir of prospect JSON files> --out out [--settings <settings JSON file>]
//
// Writes out/redraft.json: [{ id, data }] updates to apply.

const fs = require('fs');
const path = require('path');
const { composeInitial } = require('../lib/outreach/compose');
const { loadSettings } = require('../lib/outreach/settings');
const { cleanPersonName } = require('../lib/outreach/enrich');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const EDITED = /^(Edited the draft|Saved as a Gmail draft|Rewr)/;

const dir = arg('docs');
const outDir = arg('out', 'out');
const settings = loadSettings(arg('settings'));
// Drafts in the generated format say "<major> major at <school>"; anything
// else was written by hand.
const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const school = settings.school_short || settings.school_long || '';
const GENERATED = new RegExp(`${settings.sender_major ? `${reEsc(settings.sender_major)} major` : 'a student'}${school ? ` at ${reEsc(school)}` : ''}`, 'i');
fs.mkdirSync(outDir, { recursive: true });
const updates = [];
let skipped = 0;
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const doc = { id: f.replace(/\.json$/, ''), ...(raw.data || raw) };
  if (!['ready', 'queued', 'needs_check'].includes(doc.status) || !doc.email || !doc.body) continue;
  // Drafts you wrote or changed yourself stay as they are.
  if ((doc.log || []).some(l => EDITED.test(l.what || '')) || !GENERATED.test(doc.body)) { skipped++; continue; }
  // Names read badly off a page ("Steve SmithHead") are tidied first.
  const fix = n => (n && cleanPersonName(n)) || n;
  const people = ((doc.facts || {}).people || []).map(x => ({ ...x, name: fix(x.name) }));
  const contact = fix(doc.contact_name);
  const namesChanged = contact !== doc.contact_name || JSON.stringify(people) !== JSON.stringify((doc.facts || {}).people || []);
  const next = { ...doc, contact_name: contact, facts: { ...(doc.facts || {}), people } };
  const { subject, body } = composeInitial(next, settings);
  if (body === doc.body && subject === doc.subject && !namesChanged) continue;
  updates.push({ id: doc.id, data: { subject, body, ...(namesChanged ? { contact_name: contact, facts: next.facts } : {}), updated_at: new Date().toISOString() } });
}
fs.writeFileSync(path.join(outDir, 'redraft.json'), JSON.stringify(updates, null, 2));
console.log(`${updates.length} drafts rewritten, ${skipped} left alone because they were edited by hand. Wrote ${path.join(outDir, 'redraft.json')}`);
