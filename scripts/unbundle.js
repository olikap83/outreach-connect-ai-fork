// Unpacks research-code.json (see bundle-for-desk.js) into a folder.
//   node unbundle.js research-code.json ./outreach
const fs = require('fs');
const path = require('path');
const [src, dest = '.'] = process.argv.slice(2);
const { files, commit } = JSON.parse(fs.readFileSync(src, 'utf8'));
for (const [rel, text] of Object.entries(files)) {
  const out = path.join(dest, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
}
console.log(`Unpacked ${Object.keys(files).length} files (commit ${commit || 'unknown'}) into ${path.resolve(dest)}`);
