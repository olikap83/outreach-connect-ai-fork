// Where prospects come from. Both sources are free public data with no
// account, key, or card.
//
// 1. OpenStreetMap, via the Overpass API. Real storefronts and offices,
//    town by town, often with a website, phone, and sometimes an email
//    already tagged. Chains are tagged with brand:wikidata, so they're
//    easy to drop. Overpass asks for well under 10,000 requests/day; we
//    make one per town per sweep.
//
// 2. The Connecticut Business Registry on data.ct.gov (Secretary of the
//    State, updated nightly). Every CT business files a business email,
//    a NAICS industry, and its principals (owners/members/officers) —
//    this is the free stand-in for what Apollo would charge for. Used to
//    find the owner's name and filed email for an OSM business, and as a
//    second source of businesses by town.
//
// The registry's column names aren't documented anywhere stable, so they
// are read from the dataset's own metadata at run time instead of being
// hard-coded. GET /api/outreach?action=diagnose shows what was detected.

const { classifyOsm, classifyNaics, isChain } = require('./industries');
const { nameKey, normalizeUrl, domainOf, milesFromStorrs, parsePlace, stateCode, STATE_NAMES } = require('./util');

const UA = 'ConnectAI-Outreach/1.0 (UConn student class project; small-business outreach)';

const OVERPASS_ENDPOINTS = [
  // Mirrors first: the cloud research runs can't reach overpass-api.de
  // (its connections are dropped), and each failed try costs minutes.
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

const CT_DATA = 'https://data.ct.gov';
const REGISTRY_MASTER = 'n7gp-d28j';
const REGISTRY_PRINCIPALS = 'ka36-64k6';

// ---------- OpenStreetMap ----------

// Downtown coordinates for the big cities outside CT. A radius around a
// point is far cheaper for OpenStreetMap than tracing a whole city's
// boundary, which timed out for every big city.
const CITY_CENTERS = {
  'Boston, MA': [42.3601, -71.0589], 'Cambridge, MA': [42.3736, -71.1097], 'Somerville, MA': [42.3876, -71.0995], 'Worcester, MA': [42.2626, -71.8023],
  'Springfield, MA': [42.1015, -72.5898], 'Providence, RI': [41.824, -71.4128], 'Warwick, RI': [41.7001, -71.4162], 'Manhattan, NY': [40.7549, -73.984],
  'Brooklyn, NY': [40.6782, -73.9442], 'Queens, NY': [40.7282, -73.7949], 'Portsmouth, NH': [43.0718, -70.7626], 'Manchester, NH': [42.9956, -71.4548],
  'Burlington, VT': [44.4759, -73.2121], 'Portland, ME': [43.6591, -70.2568], 'Birmingham, AL': [33.5186, -86.8104], 'Anchorage, AK': [61.2181, -149.9003],
  'Phoenix, AZ': [33.4484, -112.074], 'Little Rock, AR': [34.7465, -92.2896], 'Los Angeles, CA': [34.0522, -118.2437], 'San Francisco, CA': [37.7749, -122.4194],
  'Denver, CO': [39.7392, -104.9903], 'Wilmington, DE': [39.7391, -75.5398], 'Washington, DC': [38.9072, -77.0369], 'Miami, FL': [25.7617, -80.1918],
  'Tampa, FL': [27.9506, -82.4572], 'Atlanta, GA': [33.749, -84.388], 'Honolulu, HI': [21.3069, -157.8583], 'Boise, ID': [43.615, -116.2023],
  'Chicago, IL': [41.8781, -87.6298], 'Indianapolis, IN': [39.7684, -86.1581], 'Des Moines, IA': [41.5868, -93.625], 'Wichita, KS': [37.6872, -97.3301],
  'Louisville, KY': [38.2527, -85.7585], 'New Orleans, LA': [29.9511, -90.0715], 'Baltimore, MD': [39.2904, -76.6122], 'Detroit, MI': [42.3314, -83.0458],
  'Minneapolis, MN': [44.9778, -93.265], 'Jackson, MS': [32.2988, -90.1848], 'St. Louis, MO': [38.627, -90.1994], 'Billings, MT': [45.7833, -108.5007],
  'Omaha, NE': [41.2565, -95.9345], 'Las Vegas, NV': [36.1699, -115.1398], 'Newark, NJ': [40.7357, -74.1724], 'Jersey City, NJ': [40.7178, -74.0431],
  'Albuquerque, NM': [35.0844, -106.6504], 'Charlotte, NC': [35.2271, -80.8431], 'Fargo, ND': [46.8772, -96.7898], 'Columbus, OH': [39.9612, -82.9988],
  'Oklahoma City, OK': [35.4676, -97.5164], 'Portland, OR': [45.5152, -122.6784], 'Philadelphia, PA': [39.9526, -75.1652], 'Pittsburgh, PA': [40.4406, -79.9959],
  'Charleston, SC': [32.7765, -79.9311], 'Sioux Falls, SD': [43.5446, -96.7311], 'Nashville, TN': [36.1627, -86.7816], 'Austin, TX': [30.2672, -97.7431],
  'Houston, TX': [29.7604, -95.3698], 'Salt Lake City, UT': [40.7608, -111.891], 'Richmond, VA': [37.5407, -77.436], 'Seattle, WA': [47.6062, -122.3321],
  'Charleston, WV': [38.3498, -81.6326], 'Milwaukee, WI': [43.0389, -87.9065], 'Cheyenne, WY': [41.14, -104.8202],
};

function overpassQuery(town, state = 'CT') {
  const center = CITY_CENTERS[`${town}, ${state}`];
  if (center) {
    const [lat, lon] = center;
    const r = 4000; // meters: downtown and the neighborhoods around it
    return `[out:json][timeout:90];
(
  nwr["name"]["website"](around:${r},${lat},${lon});
  nwr["name"]["contact:website"](around:${r},${lat},${lon});
  nwr["name"]["email"](around:${r},${lat},${lon});
);
out center tags 600;`;
  }
  const t = town.replace(/"/g, '');
  const st = String(state).toUpperCase().replace(/[^A-Z]/g, '');
  // Only places that list a website or email: everything else is dropped
  // later anyway, and asking for every shop in a big city times out.
  return `[out:json][timeout:120];
area["ISO3166-2"="US-${st}"]["admin_level"="4"]->.ct;
rel["boundary"="administrative"]["name"="${t}"](area.ct)->.r;
.r map_to_area->.t;
(
  nwr(area.t)["name"]["website"];
  nwr(area.t)["name"]["contact:website"];
  nwr(area.t)["name"]["email"];
  nwr(area.t)["name"]["contact:email"];
);
out center tags 800;`;
}

async function runOverpass(query, fetchImpl = fetch) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(95000),
      });
      if (resp.status === 429 || resp.status >= 500) throw new Error(`${new URL(url).host} HTTP ${resp.status}`);
      if (!resp.ok) throw new Error(`${new URL(url).host} HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No Overpass endpoint answered');
}

// One OSM element → a prospect row (or null if it isn't one we want).
// Nonprofits, clubs and public bodies aren't who this outreach is for.
const NOT_A_BUSINESS = /\b(friends of|foundation|association|society|church|parish|ministr(y|ies)|temple|synagogue|mosque|chapter|alliance|coalition|council|committee|club|league|union|advocacy|town of|city of|state of|department|school district|public library|museum|historical)\b/i;

function osmToProspect(el, town, state = 'CT') {
  const tags = el.tags || {};
  const name = (tags.name || '').trim();
  if (!name || name.length < 3) return null;
  if (isChain(name, tags) || NOT_A_BUSINESS.test(name) || /^\d+\s+\S+.*\b(road|rd|street|st|avenue|ave|lane|ln|drive|dr|route|rt|highway|hwy|turnpike|tpke)\b/i.test(name)) return null;
  if (/^(ngo|association|religion|government|political_party|educational_institution|union|charity|diplomatic)$/.test(tags.office || '')) return null;
  if (tags.disused || tags['disused:shop'] || tags.abandoned || tags['was:shop']) return null;
  const kind = classifyOsm(tags);
  if (!kind) return null;

  const website = normalizeUrl(tags.website || tags['contact:website'] || tags.url);
  const email = (tags.email || tags['contact:email'] || '').split(/[;,\s]/)[0].trim().toLowerCase() || null;
  // Nothing to email and nowhere to look for an address: skip.
  if (!website && !email) return null;

  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const city = tags['addr:city'] || town;

  return {
    name,
    name_key: nameKey(name),
    category: kind.category,
    bucket: kind.bucket,
    website,
    domain: domainOf(website),
    phone: tags.phone || tags['contact:phone'] || null,
    address: [street, city].filter(Boolean).join(', ') || null,
    town,
    state,
    lat,
    lon,
    miles_from_storrs: milesFromStorrs(lat, lon),
    source: 'osm',
    source_ref: `${el.type}/${el.id}`,
    email: email && /@/.test(email) ? email : null,
    email_source: email ? 'osm' : null,
    email_confidence: email ? 'medium' : null,
    facts: {
      osm: {
        opening_hours: tags.opening_hours || null,
        operator: tags.operator || null,
        start_date: tags.start_date || null,
      },
    },
  };
}

// place is a CT town ("Mansfield") or "Town, ST" ("Boston, MA").
async function sourceTownFromOsm(place, fetchImpl = fetch) {
  const { town, state } = parsePlace(place);
  if (!town) return []; // a whole state is too big for one map query; the registry covers it
  const data = await runOverpass(overpassQuery(town, state), fetchImpl);
  const out = [];
  const seen = new Set();
  for (const el of data.elements || []) {
    const p = osmToProspect(el, town, state);
    if (!p || seen.has(p.name_key)) continue;
    seen.add(p.name_key);
    out.push(p);
  }
  return out;
}

// ---------- CT Business Registry ----------

let columnCache = {};

async function datasetColumns(id, fetchImpl = fetch) {
  if (columnCache[id]) return columnCache[id];
  const resp = await fetchImpl(`${CT_DATA}/api/views/${id}.json`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`data.ct.gov ${id} metadata HTTP ${resp.status}`);
  const meta = await resp.json();
  const cols = (meta.columns || []).map(c => ({ field: c.fieldName, name: String(c.name || '') }));
  columnCache[id] = cols;
  return cols;
}

// Pick the first column whose API field name or display name matches,
// trying patterns in order of preference.
function pickColumn(cols, patterns, avoid) {
  for (const re of patterns) {
    const hit = cols.find(c => !c.field.startsWith(':') && (re.test(c.field) || re.test(c.name)) && !(avoid && (avoid.test(c.field) || avoid.test(c.name))));
    if (hit) return hit.field;
  }
  return null;
}

async function registryColumns(fetchImpl = fetch) {
  const cols = await datasetColumns(REGISTRY_MASTER, fetchImpl);
  return {
    id: pickColumn(cols, [/^id$/i, /^accountnumber$/i, /account.?number/i]),
    name: pickColumn(cols, [/^name$/i, /^business.?name$/i, /name/i], /agent|change|principal|naics|city|street|type|status/i),
    status: pickColumn(cols, [/^status$/i, /status/i], /reason|date|annual/i),
    email: pickColumn(cols, [/business.?email/i, /email/i]),
    naics: pickColumn(cols, [/naics/i], /sub/i),
    city: pickColumn(cols, [/billingcity/i, /^city$/i, /business.?city/i, /principal.*city/i, /mailing.*city/i, /city/i]),
    street: pickColumn(cols, [/billingstreet/i, /business.?street/i, /principal.*street/i, /street/i]),
    // The address's state. Out-of-state businesses registered in CT share
    // town names with ours (Mansfield MA, Coventry RI, Windham NH...).
    state: pickColumn(cols, [/billingstate/i, /business.?state/i, /principal.*state/i, /^state$/i, /mailing.*state/i], /status|statement/i),
    registered: pickColumn(cols, [/date.?registration/i, /registration.?date/i, /date.?formed/i, /formation/i, /incorporat/i]),
    type: pickColumn(cols, [/business.?type/i, /^type$/i]),
  };
}

async function principalColumns(fetchImpl = fetch) {
  const cols = await datasetColumns(REGISTRY_PRINCIPALS, fetchImpl);
  return {
    business: pickColumn(cols, [/business.?key/i, /business.?id/i, /account/i, /^business$/i, /parent/i]),
    name: pickColumn(cols, [/^name__c$/i, /principal.?name/i, /^name$/i, /full.?name/i, /name/i], /business|firm|street|city|state|country/i),
    title: pickColumn(cols, [/designation/i, /title/i, /role/i, /position/i, /type/i]),
  };
}

function soqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function socrata(id, params, fetchImpl = fetch) {
  const qs = new URLSearchParams(params);
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (process.env.CT_DATA_APP_TOKEN) headers['X-App-Token'] = process.env.CT_DATA_APP_TOKEN;
  const resp = await fetchImpl(`${CT_DATA}/resource/${id}.json?${qs}`, { headers, signal: AbortSignal.timeout(20000) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`data.ct.gov ${id} HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// Search the registry for an active business by name (used to match an
// OSM business to its filing). Returns the best row or null.
async function registryLookup(name, town, fetchImpl = fetch) {
  const c = await registryColumns(fetchImpl);
  if (!c.name) throw new Error('Could not find a name column in the registry dataset');
  const key = nameKey(name);
  const words = key.split(' ').filter(w => w.length > 2).slice(0, 3);
  if (!words.length) return null;
  const where = words.map(w => `upper(${c.name}) like ${soqlString(`%${w.toUpperCase()}%`)}`);
  if (c.status) where.push(`upper(${c.status}) like 'ACTIVE%'`);
  const rows = await socrata(REGISTRY_MASTER, { $where: where.join(' AND '), $limit: '25' }, fetchImpl);
  const scored = rows
    .map(r => {
      const rk = nameKey(r[c.name]);
      let s = 0;
      if (rk === key) s += 10;
      else if (rk.startsWith(key) || key.startsWith(rk)) s += 6;
      if (town && c.city && String(r[c.city] || '').toLowerCase().includes(town.toLowerCase())) s += 3;
      return { r, s };
    })
    .filter(x => x.s >= 6)
    .sort((a, b) => b.s - a.s);
  return scored.length ? rowToRegistry(scored[0].r, c) : null;
}

function rowToRegistry(r, c) {
  return {
    id: c.id ? r[c.id] : null,
    name: r[c.name] || null,
    status: c.status ? r[c.status] : null,
    email: c.email ? String(r[c.email] || '').trim().toLowerCase() || null : null,
    naics: c.naics ? r[c.naics] || null : null,
    city: c.city ? r[c.city] || null : null,
    street: c.street ? r[c.street] || null : null,
    state: c.state ? r[c.state] || null : null,
    registered: c.registered ? r[c.registered] || null : null,
    type: c.type ? r[c.type] || null : null,
  };
}

// The people listed on a filing: owners, members, managers, officers.
async function registryPrincipals(businessId, fetchImpl = fetch) {
  if (!businessId) return [];
  const c = await principalColumns(fetchImpl);
  if (!c.business || !c.name) return [];
  const rows = await socrata(REGISTRY_PRINCIPALS, { $where: `${c.business} = ${soqlString(businessId)}`, $limit: '10' }, fetchImpl);
  return rows
    .map(r => ({ name: tidyPersonName(r[c.name]), title: c.title ? r[c.title] || null : null }))
    .filter(p => p.name);
}

// Registry names are often "SMITH, JOHN A" or all caps.
function tidyPersonName(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (/\b(llc|pllc|inc|corp|company|co|trust|services|associates|pc|law|office|group)\b/i.test(s)) return null; // a company, not a person
  if (/,/.test(s)) {
    const [last, rest] = s.split(',').map(x => x.trim());
    s = `${rest} ${last}`;
  }
  s = s.replace(/\s+/g, ' ');
  if (s === s.toUpperCase() || s === s.toLowerCase()) {
    s = s.toLowerCase().replace(/\b([a-z])([a-z'’]*)/g, (_, a, b) => a.toUpperCase() + b);
    s = s.replace(/\bMc([a-z])/g, (_, a) => `Mc${a.toUpperCase()}`);
  }
  // Credentials and suffixes aren't part of how you'd greet someone.
  s = s.replace(/\b(d\.?\s?m\.?\s?d|d\.?\s?d\.?\s?s|m\.?\s?d|d\.?\s?o|d\.?\s?v\.?\s?m|ph\.?\s?d|c\.?\s?p\.?\s?a|esq|jr|sr|ii|iii|iv)\b\.?,?/gi, ' ')
    .replace(/^\s*(dr|mr|mrs|ms)\.?\s+/i, '')
    .replace(/\s+/g, ' ').trim();
  // Drop middle initials: "John A Smith" → "John Smith"
  s = s.replace(/^(\S+)(\s+[A-Z]\.?)+\s+(\S+)$/, '$1 $3');
  return s.split(' ').length >= 2 ? s : null;
}

const prettyTown = c => String(c || '').toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()) || null;

// Businesses in a town straight from the registry, filtered to
// industries we can help and with a filed email. Many registry rows are
// property-holding LLCs; the NAICS filter drops those.
// place is a CT town or "Town, ST": the CT registry also lists businesses
// from other states that are registered to work in Connecticut, with their
// filed emails, so it finds Boston or Providence businesses too.
async function sourceTownFromRegistry(place, fetchImpl = fetch, limit = 300) {
  const { town, state } = parsePlace(place);
  const c = await registryColumns(fetchImpl);
  if (!c.city || !c.name) throw new Error('Registry columns not detected (city/name)');
  const where = town ? [`upper(${c.city}) = ${soqlString(town.toUpperCase())}`] : [];
  if (!town && (!c.state || state === 'CT')) return []; // "whole state" only makes sense outside CT
  if (c.status) where.push(`upper(${c.status}) like 'ACTIVE%'`);
  if (c.state) where.push(`upper(${c.state}) in (${soqlString(state)}, ${soqlString(String(STATE_NAMES[state] || state).toUpperCase())})`);
  if (c.email) where.push(`${c.email} IS NOT NULL`);
  if (c.naics) where.push(`${c.naics} IS NOT NULL`);
  const rows = await socrata(REGISTRY_MASTER, { $where: where.join(' AND '), $limit: String(limit) }, fetchImpl);
  const out = [];
  for (const r of rows) {
    const reg = rowToRegistry(r, c);
    if (reg.state && stateCode(reg.state) !== state) continue;
    if (!reg.name || isChain(reg.name) || NOT_A_BUSINESS.test(reg.name) || /^\d+\s+\S+.*\b(road|rd|street|st|avenue|ave|lane|ln|drive|dr|route|rt|highway|hwy|turnpike|tpke)\b/i.test(reg.name)) continue;
    const kind = classifyNaics(reg.naics);
    if (!kind || kind.bucket === 'other') continue;
    const email = reg.email && /@/.test(reg.email) && !isFilingAgentEmail(reg.email) ? reg.email : null;
    if (!email) continue;
    const dom = email.split('@')[1];
    const website = FREEMAIL.has(dom) ? null : normalizeUrl(dom);
    out.push({
      name: prettyBusinessName(reg.name),
      name_key: nameKey(reg.name),
      category: kind.category,
      bucket: kind.bucket,
      website,
      domain: website ? domainOf(website) : null,
      address: [reg.street, reg.city].filter(Boolean).join(', ') || null,
      town: town || prettyTown(reg.city),
      state,
      source: 'registry',
      source_ref: reg.id,
      registry: reg,
      email,
      email_source: 'registry',
      email_confidence: 'medium',
      facts: {},
    });
  }
  return out;
}

function prettyBusinessName(raw) {
  const s = String(raw || '').trim()
    .replace(/,?\s*\b(a\s+)?limited liability (company|co\.?)\b\.?/i, ' LLC')
    .replace(/\s+/g, ' ');
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase()
    .replace(/\b([a-z])([a-z'’]*)/g, (_, a, b) => a.toUpperCase() + b)
    .replace(/\b(Llc|Pllc|Inc|Pc|Llp|Lp|Ltd|Pa|Dmd|Dds|Cpa|Usa)\b/g, m => m.toUpperCase())
    .replace(/\b(Of|And|The|For|In|At)\b(?!$)/g, (m, _w, off) => (off === 0 ? m : m.toLowerCase()));
}

// Addresses that belong to whoever filed the paperwork (registered-agent
// services, incorporation sites, accountants' filing desks), not the owner.
const FILING_DOMAINS = /(corporatedocfiling|legalzoom|incfile|zenbusiness|northwestregisteredagent|registeredagent|bizfilings|ctcorporation|cscglobal|corpnet|swyftfilings|mycorporation|nolo|rocketlawyer|harborcompliance|govdocfiling|filingservices|docfiling|statefilings|ctadvisors|rasi|capitolservices|andersonadvisors|cogencyglobal|vcorp|incorp|nrai|registeredagents|corporationservice|wolterskluwer|amerilife|morganwhite)\b/i;
const FILING_LOCALPARTS = /^(incorporation|incorporations|filings?|compliance|registeredagent|annualreports?|sos|statefilings?|investorrelations|investor\.?relations|ir|legal|ars)$/i;
// Back-office inboxes: the address a company filed with the state, read by
// accounts payable, tax or licensing staff rather than an owner.
const BACK_OFFICE = /(^|[._-])(accounting|accounts?payable|payables?|ap|ar|billing|invoices?|tax|taxes|taxdept|corporatetax|licens(e|es|ing)|statelicensing|legal|legalservices|compliance|financecompliance|finance|entity|entities|payroll|hr|privacy|filings?|mwgfilings|ap-ids)([._-]|$)|licens|filings|payable|compliance|taxdept|corporatetax/i;
function isFilingAgentEmail(email) {
  const [local, dom] = String(email || '').toLowerCase().split('@');
  return FILING_DOMAINS.test(dom || '') || FILING_LOCALPARTS.test(local || '') || BACK_OFFICE.test(local || '');
}

const FREEMAIL = new Set([
  'gmail.com', 'yahoo.com', 'aol.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'comcast.net', 'att.net', 'sbcglobal.net', 'snet.net', 'cox.net', 'verizon.net', 'optonline.net', 'charter.net',
  'frontier.com', 'frontiernet.net', 'protonmail.com', 'proton.me', 'ymail.com', 'rocketmail.com', 'mail.com', 'gmx.com',
  'earthlink.net', 'juno.com', 'netzero.net', 'windstream.net', 'cox.com', 'rcn.com', 'aim.com', 'mac.com', 'yahoo.co',
]);

module.exports = {
  OVERPASS_ENDPOINTS, CITY_CENTERS, REGISTRY_MASTER, REGISTRY_PRINCIPALS, FREEMAIL, isFilingAgentEmail, NOT_A_BUSINESS,
  overpassQuery, runOverpass, osmToProspect, sourceTownFromOsm,
  registryColumns, principalColumns, registryLookup, registryPrincipals, sourceTownFromRegistry,
  tidyPersonName, prettyBusinessName, pickColumn, socrata, soqlString, rowToRegistry,
  _resetColumnCache: () => { columnCache = {}; },
};
