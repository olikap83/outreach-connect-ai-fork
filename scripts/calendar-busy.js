// Turns Soham's published Outlook calendar into busy times for the next three
// weeks, for the desk's meta/calendar doc. Run by the 7:23am pre-send check
// (its environment can reach outlook.office365.com; the reply check's can't).
// Only start and end times are written, never event names.
//
//   node scripts/calendar-busy.js <ics url or file> > busy.json
//     → { busy: [{start, end}], from, to, fetched_at, events }

const fs = require('fs');
const { busyBlocks, parseIcs } = require('../lib/outreach/calendar');

async function main() {
  const src = process.argv[2];
  if (!src) throw new Error('Give the .ics link or file.');
  const text = /^https?:/i.test(src) ? await (await fetch(src)).text() : fs.readFileSync(src, 'utf8');
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("That link didn't return a calendar (no BEGIN:VCALENDAR).");
  const from = new Date();
  const to = new Date(from.getTime() + 21 * 86400000);
  const busy = busyBlocks(text, from, to);
  process.stdout.write(JSON.stringify({ busy, from: from.toISOString(), to: to.toISOString(), fetched_at: from.toISOString(), events: parseIcs(text).length }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
