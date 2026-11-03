// Spreads each weekday's emails across the day instead of sending them all
// at once (a burst of 30-40 cold emails at 8am from a personal Gmail looks
// like spam). The morning send fires once an hour, 8:17am to 3:17pm Eastern;
// each run sends its share, with a few random minutes between emails.
//
//   node scripts/send-slot.js --limit 40 --sent-today 12 --followups-due 9 --followups-today 3
//     → { hour, slots_left, first_quota, followup_quota, first_run, last_run, gaps_min: [...] }

const SLOT_HOURS = [8, 9, 10, 11, 12, 13, 14, 15]; // Eastern, at :17

function etHour(now) {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).format(now));
}

function sendSlot({ limit, sentToday = 0, followupsDue = 0, now = new Date(), random = Math.random }) {
  const hour = etHour(now);
  // A run that starts late still counts as its own hour's slot.
  const slotsLeft = Math.max(1, SLOT_HOURS.filter(h => h >= hour).length);
  const firstQuota = Math.max(0, Math.ceil((limit - sentToday) / slotsLeft));
  const followupQuota = Math.ceil(followupsDue / slotsLeft);
  const n = firstQuota + followupQuota;
  // 3 to 8 minutes between emails, never the same gap twice in a row.
  const gaps = [];
  for (let i = 1; i < n; i++) {
    let g = 3 + Math.floor(random() * 6);
    if (gaps.length && g === gaps[gaps.length - 1]) g = g === 8 ? 3 : g + 1;
    gaps.push(g);
  }
  return { hour, slots_left: slotsLeft, first_quota: firstQuota, followup_quota: followupQuota,
    first_run: hour <= SLOT_HOURS[0], last_run: hour >= SLOT_HOURS[SLOT_HOURS.length - 1], gaps_min: gaps };
}

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
  console.log(JSON.stringify(sendSlot({ limit: arg('limit', 30), sentToday: arg('sent-today', 0), followupsDue: arg('followups-due', 0) })));
}
module.exports = { sendSlot, SLOT_HOURS };
