// Pulls email opens from the open tracker (tracker/open-tracker.js) and
// matches them to the emails the desk sent.
//
//   OPENS_URL=https://<worker> OPENS_KEY=<secret> \
//     node scripts/outreach-opens.js --docs <dir of prospect JSON files> --out out
//
// Writes out/opens.json: [{ id, data }] updates for prospects whose opens
// changed. Each open records when, which email (intro, follow-up, reply) and
// where it came from. Loads that are probably not a person reading are kept
// but marked likely_auto, so the desk leaves them out of its counts:
//   - within 3 minutes of sending (your own copy, a mail scanner)
//   - from Apple's mail privacy proxy, which loads every image in the
//     background whether or not the email is read

const fs = require('fs');
const path = require('path');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const AUTO_WINDOW_MS = 3 * 60 * 1000;

function classify(hit, sentAt) {
  const net = String(hit.network || '');
  const agent = String(hit.agent || '');
  if (sentAt && new Date(hit.at) - new Date(sentAt) < AUTO_WINDOW_MS) return { likely_auto: true, why: 'within 3 minutes of sending' };
  if (/apple/i.test(net) && !/GoogleImageProxy/i.test(agent)) return { likely_auto: true, why: 'Apple Mail privacy proxy' };
  return { likely_auto: false };
}

function where(hit) {
  if (/GoogleImageProxy/i.test(hit.agent || '')) return 'Gmail';
  if (/microsoft/i.test(hit.network || '')) return `Outlook / Microsoft${hit.city ? `, ${hit.city}` : ''}`;
  const place = [hit.city, hit.region].filter(Boolean).join(', ');
  return [hit.network, place].filter(Boolean).join(', ') || null;
}

function opensFor(doc, hits) {
  const tracked = doc.tracked || [];
  const byId = new Map(tracked.map(t => [t.id, t]));
  return hits
    .filter(h => byId.has(h.id))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(h => {
      const t = byId.get(h.id);
      const c = classify(h, t.at);
      return { at: h.at, email_id: h.id, what: `${t.kind} email opened`, where: where(h), ...(c.likely_auto ? { likely_auto: true, auto_why: c.why } : {}) };
    });
}

async function main() {
  const dir = arg('docs');
  const outDir = arg('out', 'out');
  const base = String(process.env.OPENS_URL || arg('url', '')).replace(/\/+$/, '');
  const key = process.env.OPENS_KEY || arg('key', '');
  if (!base || !key) throw new Error('Set OPENS_URL and OPENS_KEY (the tracker address and its secret).');
  fs.mkdirSync(outDir, { recursive: true });
  const resp = await fetch(`${base}/opens?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`Tracker answered HTTP ${resp.status}`);
  const hits = await resp.json();
  const docs = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { id: f.replace(/\.json$/, ''), ...(j.data || j) }; });
  const now = new Date().toISOString();
  const updates = [];
  for (const doc of docs.filter(d => (d.tracked || []).length)) {
    const opens = opensFor(doc, hits);
    if (JSON.stringify(opens) === JSON.stringify(doc.opens || [])) continue;
    const real = opens.filter(o => !o.likely_auto);
    const before = (doc.opens || []).filter(o => !o.likely_auto).length;
    const data = { opens, opens_synced_at: now, opened_at: real.length ? real[0].at : null };
    if (real.length > before) data.log = [...(doc.log || []), { at: now, what: `Opened ${real.length > 1 ? `${real.length} times` : 'the email'} (last ${new Date(real[real.length - 1].at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} Eastern)` }].slice(-40);
    updates.push({ id: doc.id, data });
  }
  fs.writeFileSync(path.join(outDir, 'opens.json'), JSON.stringify(updates, null, 2));
  const tracked = docs.filter(d => (d.tracked || []).length).length;
  const opened = docs.filter(d => (d.tracked || []).length && opensFor(d, hits).some(o => !o.likely_auto)).length;
  console.log(`${hits.length} image loads from the tracker; ${tracked} tracked businesses, ${opened} opened; ${updates.length} to update. Wrote ${path.join(outDir, 'opens.json')}`);
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exit(1); });
module.exports = { opensFor, classify };
