// What the morning send writes to the class CRM after an intro email goes
// out: the full email on the timeline, notes that say it was sent (not
// "drafted"), and a contact so the page doesn't say "People: Nobody yet".
//
//   node scripts/crm-entry.js <prospect JSON file> [--sent-at ISO] [--has-contacts] [--settings <settings JSON file>]
//     → prints { touchpoint: {kind, body, contact?}, update: {...}, add_contact: {...} | null }

const fs = require('fs');
const { crmNotesNow, shortName } = require('../lib/outreach/crmnotes');
const { confirmName } = require('../lib/outreach/factsources');
const { loadSettings } = require('../lib/outreach/settings');

const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// A person's name only when it's confirmed; otherwise the business's own inbox.
function crmContact(p) {
  if (!p.email) return null;
  const named = p.contact_name && confirmName(p, p.contact_name);
  if (named) return { full_name: p.contact_name, email: p.email, ...(p.contact_title ? { title: p.contact_title } : {}), is_primary: true };
  return { full_name: `${shortName(p.name)} (main email)`, email: p.email, notes: 'The business email the intro went to; no confirmed person yet.', is_primary: true };
}

function crmEntry(p, { sentAt = new Date().toISOString(), hasContacts = false, settings = {} } = {}) {
  const sent = { ...p, status: 'sent', sent_at: p.sent_at || sentAt };
  const contact = crmContact(sent);
  return {
    touchpoint: { kind: 'email', body: `Intro email sent to ${p.email}.\nSubject: ${p.subject}\n\n${p.body}`.slice(0, 3990),
      ...(contact && contact.full_name === p.contact_name ? { contact: p.contact_name } : {}) },
    update: { stage: 'contacted', next_step: 'Follow up on intro email if no reply', next_step_due: addDays(sentAt, 6), notes: crmNotesNow(sent, settings) },
    add_contact: hasContacts ? null : contact,
  };
}

if (require.main === module) {
  const arg = n => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
  const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(JSON.stringify(crmEntry(raw.data || raw, { sentAt: arg('sent-at') || undefined, hasContacts: process.argv.includes('--has-contacts'), settings: loadSettings(arg('settings')) }), null, 2));
}
module.exports = { crmEntry, crmContact };
