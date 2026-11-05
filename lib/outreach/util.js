// Small helpers shared across the outreach pipeline.

// UConn's Storrs campus. Partners get a weekly in-person visit, so
// distance from here is part of whether a business is a realistic fit.
const STORRS = { lat: 41.8084, lon: -72.2495 };

// The area the class works in: Connecticut, Boston, New York and the rest
// of New England. Businesses here are Connect.AI candidates and go in the
// class CRM; anywhere else stays on the student's own desk.
const CLASS_STATES = ['CT', 'MA', 'RI', 'NH', 'VT', 'ME', 'NY'];
const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'Washington, DC', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
// "Texas" or "Massachusetts" → "TX" / "MA"; two-letter codes pass through.
function stateCode(s) {
  const t = String(s || '').trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  const hit = Object.entries(STATE_NAMES).find(([, n]) => n.toLowerCase() === t.toLowerCase());
  return hit ? hit[0] : t.toUpperCase();
}
function stateOf(p) { return String((p && p.state) || 'CT').toUpperCase(); }
function inClassArea(p) { return CLASS_STATES.includes(stateOf(p)); }
// "Mansfield" (CT) or "Boston, MA" → { town, state }.
// "*, TX" (a whole state, no town) → { town: null, state: 'TX' }.
function parsePlace(place) {
  const m = String(place).match(/^(.*?),\s*([A-Za-z]{2})$/);
  if (!m) return { town: String(place).trim(), state: 'CT' };
  const town = m[1].trim();
  return { town: town === '*' ? null : town, state: m[2].toUpperCase() };
}
// "Mansfield, Texas" in emails; plain town name in Connecticut.
function placeInWords(p) {
  const st = stateOf(p);
  if (!p.town) return st === 'CT' ? 'your area' : STATE_NAMES[st] || st;
  return st === 'CT' ? p.town : `${p.town}, ${STATE_NAMES[st] || st}`;
}
// How a place reads: CT towns plain, everything else with its state.
function placeLabel(p) { return stateOf(p) === 'CT' ? (p.town || '') : `${p.town || ''}, ${stateOf(p)}`; }

const LEGAL_SUFFIX = /\b(l\s?l\s?c|inc|incorporated|co|corp|corporation|company|ltd|limited|liability|pc|p\s?c|pllc|llp|lp|dba)\b/g;

// "The Gold Trader, LLC" and "Gold Trader" → "gold trader". Apostrophes
// vanish ("Munson's" → "munsons"); every other symbol becomes a space.
function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/^\s*the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function domainOf(url) {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch (e) {
    return null;
  }
}

function normalizeUrl(url) {
  if (!url) return null;
  const s = String(url).trim().split(/[;\s]/)[0];
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!/\./.test(u.hostname)) return null;
    return u.origin + (u.pathname === '/' ? '/' : u.pathname);
  } catch (e) {
    return null;
  }
}

function milesBetween(a, b) {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return null;
  const R = 3958.8;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function milesFromStorrs(lat, lon) {
  const m = milesBetween(STORRS, { lat, lon });
  return m == null ? null : Math.round(m * 10) / 10;
}

// Rough town centers for the CT towns the runs search, so a business from
// the state registry (no map coordinates) still gets a distance.
const CT_TOWN_CENTERS = {
  mansfield: [41.79, -72.23], windham: [41.71, -72.16], coventry: [41.77, -72.33], tolland: [41.87, -72.37],
  vernon: [41.82, -72.48], manchester: [41.78, -72.52], ellington: [41.90, -72.47], stafford: [41.99, -72.29],
  willington: [41.88, -72.26], ashford: [41.87, -72.12], columbia: [41.70, -72.30], hebron: [41.66, -72.37],
  lebanon: [41.64, -72.21], bolton: [41.77, -72.43], andover: [41.74, -72.37], glastonbury: [41.71, -72.61],
  'south windsor': [41.82, -72.62], 'east hartford': [41.78, -72.61], norwich: [41.52, -72.08], colchester: [41.58, -72.33],
  enfield: [41.98, -72.59], somers: [41.99, -72.45], 'east windsor': [41.91, -72.61], windsor: [41.85, -72.64],
  killingly: [41.83, -71.88], putnam: [41.92, -71.91], plainfield: [41.68, -71.92], brooklyn: [41.79, -71.95],
  pomfret: [41.90, -71.96], woodstock: [41.95, -71.97], thompson: [41.96, -71.86], hartford: [41.76, -72.68],
  'west hartford': [41.76, -72.74], wethersfield: [41.71, -72.65], 'rocky hill': [41.66, -72.64], middletown: [41.56, -72.65],
  storrs: [41.81, -72.25], willimantic: [41.71, -72.21],
};
// The business's own distance, else its CT town center's.
function milesOf(p) {
  if (p && p.miles_from_storrs != null) return Number(p.miles_from_storrs);
  if (!p || stateOf(p) !== 'CT') return null;
  const c = CT_TOWN_CENTERS[String(p.town || '').toLowerCase().trim()];
  return c ? milesFromStorrs(c[0], c[1]) : null;
}

// Wall-clock parts in New York time, whatever timezone the server runs in.
function nyParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value;
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    weekday: get('weekday'), // Mon, Tue, ...
  };
}

// Start of today in New York, as a UTC Date — for "sent today" counts.
function nyStartOfDay(date = new Date()) {
  const { ymd } = nyParts(date);
  // Try both possible offsets (EST/EDT) and keep the one that maps back to midnight.
  for (const off of ['-04:00', '-05:00']) {
    const d = new Date(`${ymd}T00:00:00${off}`);
    if (nyParts(d).ymd === ymd && nyParts(d).hour === 0) return d;
  }
  return new Date(`${ymd}T00:00:00-05:00`);
}

// Business days between two dates (Mon–Fri), not counting the start day.
function businessDaysSince(from, to = new Date()) {
  let n = 0;
  const d = new Date(from);
  d.setUTCHours(12, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(12, 0, 0, 0);
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

function firstName(full) {
  const parts = String(full || '').replace(/^(dr|mr|mrs|ms|miss)\.?\s+/i, '').replace(/^(d\.?m\.?d|d\.?d\.?s|m\.?d)\.?\s+/i, '').trim().split(/\s+/);
  const f = parts[0] || '';
  return /^[A-Z][a-zA-Z'’-]+$/.test(f) && f.length > 1 ? f : null;
}

// Stable small hash, used to vary wording between emails so a batch
// doesn't go out as twenty copies of the same sentence.
function hashPick(seed, n) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(h) % n;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Runs fn over items, at most `limit` at a time.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { CLASS_STATES, STATE_NAMES, stateCode, placeInWords, stateOf, inClassArea, parsePlace, placeLabel,
  STORRS, nameKey, domainOf, normalizeUrl, milesBetween, milesFromStorrs, milesOf,
  nyParts, nyStartOfDay, businessDaysSince, firstName, hashPick, sleep, mapLimit,
};
