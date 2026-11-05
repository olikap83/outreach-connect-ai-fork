// Packs the research code into one JSON file ({ path: contents }) that is
// published alongside the Outreach Desk page. The scheduled runs read the page's files
// and unpack this, so they run the same code the desk was published with. Run it after changing the code, then republish the desk
// with the bundle as `research-code.json`.
//
//   node scripts/bundle-for-desk.js > /tmp/research-code.json

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const include = ['package.json', 'package-lock.json', 'lib', 'scripts'];

const files = {};
function add(rel) {
  const abs = path.join(root, rel);
  if (fs.statSync(abs).isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) add(path.join(rel, name));
  } else if (/\.(js|json)$/.test(rel)) {
    files[rel.split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
  }
}
include.forEach(add);
// The student's own profile (not in git) rides along with their desk's copy of the code.
if (fs.existsSync(path.join(root, 'profile.json'))) add('profile.json');

const { execSync } = require('child_process');
let commit = null;
try { commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch (e) { /* not a git checkout */ }
process.stdout.write(JSON.stringify({ commit, built_at: new Date().toISOString(), files }));
