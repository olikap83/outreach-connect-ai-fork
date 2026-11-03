// When a business owner says yes to a call, this writes Soham's answer:
// two open times from his calendar (meta/calendar on the desk), Teams or
// whatever's easiest, and a short line about Connect.AI, which is the point
// of the call. The reply check saves it as a Gmail draft in their thread for
// Soham to send.
//
//   node scripts/meeting-reply.js <prospect JSON file> <calendar JSON file>
//     → { body, slots: [iso...], slot_text: [...] } or { skip: reason }

const fs = require('fs');
const { callOptions, slotText } = require('../lib/outreach/calendar');
const { shortName } = require('../lib/outreach/crmnotes');

function firstName(p) {
  const greet = (/^Hi ([^\n,]+),/.exec(p.body || '') || [])[1] || '';
  if (!greet || / team$/i.test(greet)) return null;
  return greet.replace(/^Dr\.\s+/, 'Dr. ');
}

function meetingReply(p, cal, { now = new Date() } = {}) {
  const ageH = cal && cal.fetched_at ? (now - new Date(cal.fetched_at)) / 3600000 : Infinity;
  if (!cal || !Array.isArray(cal.busy)) return { skip: "Soham's calendar hasn't been read yet" };
  if (ageH > 72) return { skip: "Soham's calendar is more than 3 days old; the 7:23am run may not be reading it" };
  const slots = callOptions(cal.busy, { now });
  if (slots.length < 2) return { skip: 'Not enough open times in the next two weeks' };
  const name = firstName(p);
  const biz = shortName(p.name);
  const texts = slots.map(slotText);
  const body = [
    name ? `Hi ${name},` : 'Hi,',
    `Thanks so much for getting back to me! Here are a few times that work on my end:\n\n${texts.map(t => `- ${t}`).join('\n')}\n\nIf none of those fit, just send me a time that's better for you and I'll make it work. Teams, Zoom or phone all work for me, and I'm happy to send the invite.`,
    `I'd love to hear how ${biz} got started. I'd also like to tell you a bit about Connect.AI, a UConn course I'm in where student teams help small businesses use AI, for free.`,
    'Thanks,\nSoham',
  ].join('\n\n');
  return { body, slots: slots.map(d => d.toISOString()), slot_text: texts };
}

if (require.main === module) {
  const read = f => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j.data || j; };
  process.stdout.write(JSON.stringify(meetingReply(read(process.argv[2]), read(process.argv[3]))));
}
module.exports = { meetingReply };
