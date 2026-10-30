// The reply check that runs without the desk open.
//
//   node scripts/outreach-replies.js queries --docs <dir of prospect JSON files>
//     → prints the Gmail searches to run (one per line)
//
//   node scripts/outreach-replies.js plan --docs <dir> --threads <file> --out <dir>
//     <file> holds the search results: the threads arrays from every search,
//     either one JSON array or several, one per line.
//     → writes <out>/updates/<id>.json (desk update for each business),
//       <out>/plan.json ({ updates: [{id, file, crm_org_id}], notify: [...] })
//       and prints a short summary.

const fs = require('fs');
const path = require('path');
const { planReplies } = require('../lib/outreach/replies');

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };

function readDocs(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { id: f.replace(/\.json$/, ''), ...(j.data || j) }; });
}

function readThreads(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  const chunks = text.startsWith('[') && !text.includes('\n[') ? [text] : text.split('\n').filter(l => l.trim());
  return chunks.flatMap(c => { const j = JSON.parse(c); return Array.isArray(j) ? j : j.threads || []; });
}

function queries(docs) {
  const emails = [...new Set(docs.filter(p => ['sent', 'followed_up', 'replied'].includes(p.status) && p.email).map(p => p.email.toLowerCase()))].sort();
  const out = [];
  for (let i = 0; i < emails.length; i += 20) out.push(`from:(${emails.slice(i, i + 20).join(' OR ')}) newer_than:60d -in:sent`);
  return out;
}

function main() {
  const mode = process.argv[2];
  const docs = readDocs(arg('docs'));
  if (mode === 'queries') { console.log(queries(docs).join('\n')); return; }
  if (mode !== 'plan') throw new Error('Use "queries" or "plan".');
  const out = arg('out') || 'out/replies';
  fs.mkdirSync(path.join(out, 'updates'), { recursive: true });
  const { updates, notify } = planReplies(docs, readThreads(arg('threads')));
  const list = updates.map(u => {
    const file = path.resolve(out, 'updates', `${u.id}.json`);
    fs.writeFileSync(file, JSON.stringify(u.data));
    return { id: u.id, file, crm_org_id: u.crm_org_id || null };
  });
  fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify({ updates: list, notify }, null, 2));
  console.log(`${notify.length} to tell Soham about, ${list.length} desk update(s). Wrote ${path.join(out, 'plan.json')}`);
}

if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exit(1); } }
module.exports = { queries, readThreads };
