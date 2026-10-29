// Re-checks drafts already on the desk with the current rules (office
// address from the state filing, website has to match the business's name
// and place, email has to clearly belong to the business). Anything that no
// longer passes is moved to "Needs a look" with the reason.
//
//   node scripts/outreach-recheck.js --docs <dir of prospect JSON files> --out out
//
// <dir> is what ArtifactData list writes with out_dir: one <id>.json per
// prospect. Writes out/recheck.json: [{ id, data }] updates to apply.

const fs = require('fs');
const path = require('path');
const { enrichProspect } = require('../lib/outreach/enrich');
const { registryLookup } = require('../lib/outreach/sources');
const { readinessProblems } = require('../lib/outreach/verify');
const { mapLimit, stateOf, stateCode } = require('../lib/outreach/util');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };

async function recheck(doc) {
  const p = {
    name: doc.name, town: doc.town, state: stateOf(doc), source: doc.source, bucket: doc.bucket, category: doc.category,
    website: doc.website || null, domain: doc.domain || null, email: doc.email, email_source: doc.email_source,
    contact_name: doc.contact_name, facts: {},
  };
  const problems = [];
  if (doc.source === 'registry') {
    const reg = await registryLookup(doc.name, null).catch(() => null);
    if (reg) {
      p.registry = reg;
      const where = `${reg.city || '?'}, ${stateCode(reg.state || '') || '?'}`;
      if (reg.location_from === 'office' && (String(reg.city || '').toLowerCase() !== String(doc.town || '').toLowerCase() || stateCode(reg.state || '') !== stateOf(doc))) {
        problems.push(`The state filing puts the business in ${where}, not ${doc.town}, ${stateOf(doc)}, so the draft has the wrong place.`);
      }
    }
  }
  const patch = await enrichProspect(p, { findWebsite: false });
  const merged = { ...p, ...patch };
  if (doc.email && merged.email !== doc.email) problems.push(`${doc.email} no longer checks out as this business's own address.`);
  problems.push(...readinessProblems({ ...merged, email: doc.email }));
  const registryId = merged.registry?.id || null;
  // Passing drafts still get the filing's id, for the desk's links to it.
  if (!problems.length) return registryId && registryId !== doc.registry_id ? { id: doc.id, data: { registry_id: registryId } } : null;
  const now = new Date().toISOString();
  return {
    id: doc.id,
    data: {
      status: 'needs_check', check_problems: [...new Set(problems)], registry_id: registryId,
      website: merged.website ?? null, domain: merged.domain ?? null, website_verified: !!merged.website_verified,
      updated_at: now, log: [...(doc.log || []), { at: now, what: `Moved to "Needs a look": ${problems[0]}` }].slice(-40),
    },
  };
}

async function main() {
  const dir = arg('docs');
  const outDir = arg('out', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const docs = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({ id: f.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  const todo = docs.filter(d => ['ready', 'queued'].includes(d.status) && d.email);
  console.log(`Re-checking ${todo.length} drafts`);
  let i = 0;
  const updates = (await mapLimit(todo, 4, async d => {
    try {
      const u = await recheck(d);
      console.log(`  [${++i}/${todo.length}] ${d.name}: ${u && u.data.status ? `needs a look (${u.data.check_problems[0]})` : 'ok'}`);
      return u;
    } catch (err) {
      console.log(`  [${++i}/${todo.length}] ${d.name}: check failed (${err.message}); left as is`);
      return null;
    }
  })).filter(Boolean);
  fs.writeFileSync(path.join(outDir, 'recheck.json'), JSON.stringify(updates, null, 2));
  console.log(`${updates.filter(u => u.data.status).length} of ${todo.length} moved to "Needs a look"; ${updates.filter(u => !u.data.status).length} got their filing link. Wrote ${path.join(outDir, 'recheck.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
