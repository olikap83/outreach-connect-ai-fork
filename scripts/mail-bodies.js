// The plain and HTML versions of an email, exactly as the desk sends them
// (clean "LinkedIn" link, clickable UConn address). Used by the morning send
// job so emails look the same whichever way they go out.
//
//   node scripts/mail-bodies.js <prospect JSON file>   → prints {body, htmlBody}

const fs = require('fs');

const LINKEDIN_URL = 'https://www.linkedin.com/in/soham-shah-uconn';
const LINKEDIN = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/soham-shah-uconn\/?/g;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mailBodies(body) {
  const html = esc(body)
    .replace(LINKEDIN, `<a href="${LINKEDIN_URL}">LinkedIn</a>`)
    .replace(/soham\.shah@uconn\.edu/g, '<a href="mailto:soham.shah@uconn.edu">soham.shah@uconn.edu</a>')
    .replace(/\n/g, '<br>');
  return { body: body.replace(LINKEDIN, LINKEDIN_URL), htmlBody: `<div>${html}</div>` };
}

if (require.main === module) {
  const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const doc = raw.data || raw;
  process.stdout.write(JSON.stringify(mailBodies(doc.body || '')));
}
module.exports = { mailBodies };
