// Enrichment: read a business's own website (home page plus its contact,
// about, and team pages) and pull out what a person would notice in five
// minutes of looking:
//
//   - a real email address, ranked so the owner's own address beats
//     info@, and a web designer's address never wins
//   - the owner's / founder's name, if the site says it
//   - facts worth mentioning: years in business, family-owned, books by
//     phone only, takes quote requests, hiring, what tools the site runs on
//
// Then, if the CT registry has the business, its filed email and the
// principals listed on the filing fill the gaps. Every address is
// checked for MX records (free DNS lookup) before it's trusted.
//
// No paid API anywhere in here: it's fetch + cheerio + DNS.

const cheerio = require('cheerio');
const dns = require('node:dns').promises;
const { looksLikeName } = require('../nameFilter');
const { FREEMAIL, registryLookup, registryPrincipals, isFilingAgentEmail } = require('./sources');
const { domainOf, normalizeUrl, nameKey, firstName, stateOf, stateCode, STATE_NAMES } = require('./util');
const { ddgSearch } = require('../ddg');

// Sites that list businesses but aren't the business's own website.
const DIRECTORY = /(facebook|instagram|linkedin|yelp|yellowpages|bbb\.org|manta|bizapedia|opencorporates|mapquest|google|bing|duckduckgo|indeed|glassdoor|angi|homeadvisor|houzz|thumbtack|nextdoor|tripadvisor|doordash|grubhub|ubereats|zillow|realtor\.com|chamberofcommerce|buzzfile|dnb\.com|zoominfo|corporationwiki|ctcorporations|bizstanding|allbiz|cylex|merchantcircle|superpages|citysearch|wikipedia|youtube|twitter|x\.com|tiktok|pinterest|ct\.gov|uconn\.edu)/i;

async function findWebsite(name, town, fetchImpl = fetch) {
  const short = String(name).replace(/,?\s*\b(llc|inc|corp|co|ltd|pc|pllc)\b\.?/gi, '').trim();
  const items = await ddgSearch(`"${short}" ${town || ''} CT`);
  for (const it of items.slice(0, 8)) {
    let url = it.link || '';
    const m = url.match(/[?&]uddg=([^&]+)/);
    if (m) url = decodeURIComponent(m[1]);
    if (!/^https?:/i.test(url)) url = `https:${url}`;
    const host = domainOf(url);
    if (!host || DIRECTORY.test(host)) continue;
    const words = nameKey(short).split(' ').filter(w => w.length > 3);
    const hay = `${it.title} ${host}`.toLowerCase();
    if (words.length && words.some(w => hay.includes(w))) return `https://${host}/`;
  }
  return null;
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SUBPAGE_HINT = /(contact|about|team|staff|our-?story|who-?we-?are|meet|leadership|owner|people|providers|doctors|attorneys|agents)/i;

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const BAD_EMAIL_DOMAIN = /(sentry|wixpress|example\.|domain\.com|email\.com|yourdomain|yoursite|sitename|godaddy|squarespace|wix\.com|weebly|mysite|test\.com|latofonts|w3\.org|schema\.org|cloudflare|googleapis|gstatic|jquery|bootstrap|fontawesome|placeholder)/i;
const BAD_LOCALPART = /^(no-?reply|do-?not-?reply|donotreply|privacy|abuse|postmaster|webmaster|hostmaster|mailer-daemon|unsubscribe|bounce|filler|user|username|name|email|you|your|john\.?doe|jane\.?doe|test)$/i;
const ASSET_EXT = /\.(png|jpe?g|gif|webp|svg|css|js|ico|bmp|tiff?|mp4|pdf)$/i;
const ROLE_RANK = {
  owner: 62, office: 60, hello: 58, info: 55, contact: 55, appointments: 57, appointment: 57, frontdesk: 57,
  scheduling: 57, schedule: 57, service: 52, sales: 50, admin: 48, reception: 56, team: 50, mail: 48, inquiries: 54,
  inquiry: 54, orders: 45, billing: 35, accounts: 35, accounting: 35, support: 40, help: 40, careers: 15, jobs: 15,
  hr: 15, employment: 15, marketing: 25, media: 20, press: 20, webmaster: 5,
};

const BOOKING_TOOLS = {
  calendly: /calendly\.com/i, acuity: /acuityscheduling|as\.me\//i, square: /squareup\.com\/appointments|square\.site|book\.squareup/i,
  vagaro: /vagaro\.com/i, mindbody: /mindbodyonline|mindbody\.io|healcode/i, schedulicity: /schedulicity/i, zocdoc: /zocdoc\.com/i,
  nexhealth: /nexhealth/i, localmed: /localmed/i, solutionreach: /solutionreach/i, weave: /getweave|weavehelp/i,
  opentable: /opentable\.com/i, resy: /resy\.com/i, tock: /exploretock/i, toast: /toasttab\.com/i, chownow: /chownow\.com/i,
  housecallpro: /housecallpro/i, servicetitan: /servicetitan/i, jobber: /getjobber|clienthub\.getjobber/i, setmore: /setmore\.com/i,
  simplybook: /simplybook/i, booksy: /booksy\.com/i, glossgenius: /glossgenius/i, fresha: /fresha\.com/i, janeapp: /janeapp\.com/i,
  boulevard: /joinblvd|blvd\.co/i, practicebetter: /practicebetter/i, wellnessliving: /wellnessliving/i, clover: /clover\.com\/online-ordering/i,
};
const CHAT_TOOLS = { tawk: /tawk\.to/i, intercom: /intercom(cdn)?\.(io|com)/i, drift: /drift\.com|js\.driftt/i, livechat: /livechatinc/i, tidio: /tidio/i, podium: /podium\.com/i, birdeye: /birdeye\.com/i, hubspot: /js\.hs-scripts|hubspot/i, zendesk: /zdassets|zendesk/i };
const SHOP_TOOLS = { shopify: /cdn\.shopify|myshopify/i, woocommerce: /woocommerce/i, bigcommerce: /bigcommerce/i, ecwid: /ecwid/i, square_online: /square\.site|editmysite/i };
const PARKED_SITE = /(^|\.)(expireddomains\.com|hugedomains\.com|sedo\.com|dan\.com|afternic\.com|bodis\.com|parkingcrew\.net|domainmarket\.com|undeveloped\.com)$/i;
const PLATFORMS = { wix: /wixstatic|_wix|wix\.com/i, squarespace: /squarespace/i, godaddy: /img1\.wsimg\.com|godaddy/i, weebly: /weebly/i, wordpress: /wp-content|wp-includes/i, duda: /dudaone|multiscreensite|duda\.co/i, webflow: /webflow/i };

async function fetchPage(url, fetchImpl = fetch) {
  const resp = await fetchImpl(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const type = resp.headers?.get?.('content-type') || 'text/html';
  if (!/html|text/i.test(type)) throw new Error(`not HTML (${type})`);
  const html = await resp.text();
  return { url: resp.url || url, html: html.slice(0, 1_500_000) };
}

// Cloudflare's email obfuscation: data-cfemail="<hex>" — first byte is the XOR key.
function decodeCfEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch (e) {
    return '';
  }
}

function cleanEmail(raw) {
  let e = String(raw || '').trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
  try { e = decodeURIComponent(e); } catch (err) { /* keep as-is */ }
  e = e.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(e)) return null;
  if (ASSET_EXT.test(e) || /@\d+x\./.test(e)) return null;
  let [local, dom] = e.split('@');
  // Page text often runs a phone number or zip code into the address:
  // "431-7682fireflypotterynh@gmail.com", "02909info@thermiapvd.com".
  local = local.replace(/^.*?\d{3}[-.]\d{4}(?=[a-z])/, '').replace(/^\d{5}(?=[a-z])/, '');
  if (!local) return null;
  e = `${local}@${dom}`;
  if (BAD_EMAIL_DOMAIN.test(dom) || BAD_LOCALPART.test(local)) return null;
  if (isFilingAgentEmail(e)) return null;
  if (/^[a-f0-9]{16,}$/.test(local)) return null; // tracking hashes
  return e;
}

function textOf($) {
  const $c = $.root().clone();
  $c.find('script, style, noscript, svg, iframe').remove();
  return $c.text().replace(/\s+/g, ' ').trim();
}

// People named with a role on the page: "Jane Smith, Owner", "Owner: Jane
// Smith", "Dr. Jane Smith, DMD", and JSON-LD founders/employees.
const ROLE_LIST = ['owner', 'co-owner', 'founder', 'co-founder', 'president', 'proprietor', 'principal', 'ceo', 'managing partner', 'partner', 'operator', 'general manager', 'office manager', 'practice manager', 'dmd', 'dds', 'cpa', 'esq', 'attorney', 'broker', 'director'];
// Role words match in any case ("Owner", "OWNER", "DMD"); the name part
// next to them stays case-sensitive so "the owner" isn't read as a name.
const anyCase = w => w.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`);
const ROLE_WORDS = ROLE_LIST.map(anyCase).join('|');
const ROLE_AFTER = new RegExp(`(?:Dr\\.?\\s+)?([A-Z][a-zA-Z'’.-]+(?:\\s+[A-Z]\\.)?\\s+[A-Z][a-zA-Z'’-]+(?:\\s+[A-Z][a-zA-Z'’-]+)?)\\s*(?:,|–|—|-|\\||\\(|is the|is our|our)\\s*(?:the\\s+)?(${ROLE_WORDS})\\b`, 'g');
const ROLE_BEFORE = new RegExp(`\\b(${ROLE_WORDS})\\s*(?:[:,–—-]|is|and)\\s*(?:Dr\\.?\\s+)?([A-Z][a-zA-Z'’.-]+(?:\\s+[A-Z]\\.)?\\s+[A-Z][a-zA-Z'’-]+)`, 'g');
const ROLE_PRIORITY = ['owner', 'co-owner', 'founder', 'co-founder', 'president', 'proprietor', 'ceo', 'managing partner', 'principal', 'dmd', 'dds', 'partner', 'operator', 'cpa', 'esq', 'attorney', 'broker', 'general manager', 'director', 'practice manager', 'office manager'];

function rolePriority(role) {
  const i = ROLE_PRIORITY.indexOf(String(role || '').toLowerCase());
  return i === -1 ? ROLE_PRIORITY.length : i;
}

// Job titles that end up glued to a name when a site puts them in the next
// element with no space: "Jason SteelePresident" → "Jason Steele".
const GLUED_TITLE = /([a-z])(President|Vice|Owner|Co-?Founder|Founder|CEO|COO|CFO|Principal|Manager|Director|Partner|Broker|Agent|Realtor|Officer|Member)\b.*$/;
// Same city and state as the business we found ("New York" counts for
// Manhattan, Brooklyn and so on).
const NYC = /^(manhattan|brooklyn|queens|bronx|staten island)$/i;
function registryIsLocal(reg, p) {
  const regState = stateCode(reg.state) || 'CT';
  if (regState !== stateOf(p)) return false;
  const town = String(p.town || '').toLowerCase().trim();
  const city = String(reg.city || '').toLowerCase().trim();
  if (!town || !city) return false;
  return city === town || (NYC.test(town) && city === 'new york');
}

function cleanPersonName(s) {
  const n = String(s || '').replace(/^Dr\.?\s+/i, '').replace(GLUED_TITLE, '$1').replace(/\s+[A-Z]\.\s+/, ' ')
    .replace(/\s+(Co|Inc|LLC|PC)\.?$/i, '').replace(/\s+/g, ' ').trim()
    .replace(/^(\S+)(\s.+)\s\1$/i, '$1$2'); // "Mark Murphy Mark" → "Mark Murphy"
  // "Pc Bennett Law Office" is a business, not a person.
  if (/\b(pc|llc|inc|corp|law|office|group|services?|company|associates|partners|clinic|center|agency)\b/i.test(n)) return null;
  return looksLikeName(n) ? n : null;
}

// The page whose text has this phone number (any formatting), or null.
function phoneOnPages(phone, pages) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length < 10) return null;
  const hit = (pages || []).find(pg => String(pg.text || '').replace(/\D/g, '').includes(digits) || String(pg.html || '').replace(/\D/g, '').includes(digits));
  return hit ? hit.url : null;
}

function findPeople(text, jsonld) {
  const people = [];
  const add = (name, role, how) => {
    const n = cleanPersonName(name);
    if (!n) return;
    const r = String(role || '').toLowerCase().replace(/^the\s+/, '');
    if (people.some(p => p.name === n)) return;
    people.push({ name: n, role: r || null, how });
  };
  for (const obj of jsonld) {
    const founders = [].concat(obj.founder || []);
    for (const f of founders) add(typeof f === 'string' ? f : f?.name, 'founder', 'site data');
    for (const e of [].concat(obj.employee || [], obj.employees || [])) add(e?.name, e?.jobTitle, 'site data');
    if (obj['@type'] === 'Person' && obj.jobTitle) add(obj.name, obj.jobTitle, 'site data');
  }
  const snippet = text.slice(0, 60000);
  for (const m of snippet.matchAll(ROLE_AFTER)) add(m[1], m[2], 'site text');
  for (const m of snippet.matchAll(ROLE_BEFORE)) add(m[2], m[1], 'site text');
  people.sort((a, b) => rolePriority(a.role) - rolePriority(b.role));
  return people.slice(0, 6);
}

function parseJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const walk = d => {
        if (!d) return;
        if (Array.isArray(d)) return d.forEach(walk);
        if (typeof d !== 'object') return;
        out.push(d);
        if (d['@graph']) walk(d['@graph']);
      };
      walk(data);
    } catch (e) { /* malformed JSON-LD is common; ignore */ }
  });
  return out;
}

// Everything worth knowing from one page.
function extractPage(html, pageUrl) {
  const $ = cheerio.load(html);
  const emails = new Set();
  $('a[href^="mailto:" i]').each((_, a) => { const e = cleanEmail($(a).attr('href')); if (e) emails.add(e); });
  $('[data-cfemail]').each((_, el) => { const e = cleanEmail(decodeCfEmail($(el).attr('data-cfemail'))); if (e) emails.add(e); });
  const text = textOf($);
  const deobf = text
    .replace(/%40/g, '@').replace(/%20/g, ' ')
    .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, '@')
    .replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, '.');
  for (const m of deobf.matchAll(EMAIL_RE)) { const e = cleanEmail(m[0]); if (e) emails.add(e); }
  // Decode %20/%40 first, or "mailto:%20info@x.com" reads as "20info@x.com".
  const htmlDecoded = html.replace(/&#64;|&#x40;|%40/gi, '@').replace(/%20|%0a|%0d/gi, ' ');
  for (const m of htmlDecoded.matchAll(EMAIL_RE)) { const e = cleanEmail(m[0]); if (e) emails.add(e); }

  const jsonld = parseJsonLd($);
  const host = domainOf(pageUrl);
  const links = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    const label = $(a).text().trim();
    try {
      const u = new URL(href, pageUrl);
      if (!/^https?:$/.test(u.protocol)) return;
      links.push({ url: u.href.split('#')[0], host: domainOf(u.href), label, path: u.pathname });
    } catch (e) { /* bad href */ }
  });

  const paragraphs = [];
  $('p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length >= 80 && t.length <= 600 && !/cookie|privacy|copyright|©|all rights reserved|javascript/i.test(t)) paragraphs.push(t);
  });
  return {
    url: pageUrl,
    host,
    paragraphs: paragraphs.slice(0, 8),
    title: $('title').first().text().trim(),
    description: ($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '').trim(),
    text,
    html,
    emails: [...emails],
    jsonld,
    links,
  };
}

function detect(map, html) {
  return Object.keys(map).filter(k => map[k].test(html));
}

// Facts from all crawled pages together.
// Signs on their own site that this is a larger company, not the kind of
// small business the class works with (NEXDINE Hospitality: a C-suite, a
// "Chief Growth Officer", corporate dining across several states).
const NUM_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
function bigCompanySignals(text) {
  const out = [];
  const n = s => Number(String(s).replace(/,/g, '')) || NUM_WORDS[String(s).toLowerCase()] || 0;
  const emp = [...text.matchAll(/\b(?:over |more than )?([\d,]{3,7})\+?\s+(?:employees|team members|associates|staff)\b/gi)].map(m => n(m[1])).filter(x => x >= 100);
  if (emp.length) out.push(`about ${Math.max(...emp).toLocaleString('en-US')} employees`);
  const locs = [...text.matchAll(/\b([\d,]{2,5})\+?\s+(?:locations|offices|branches|stores|restaurants|properties|facilities|communities|clinics)\b/gi)].map(m => n(m[1])).filter(x => x >= 10);
  if (locs.length) out.push(`${Math.max(...locs)}+ locations`);
  const states = [...text.matchAll(/\b(?:in|across|serving|throughout)\s+(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s+states\b/gi)].map(m => n(m[1])).filter(x => x >= 3);
  if (states.length) out.push(`operates in ${Math.max(...states)} states`);
  else if (/\b(nationwide|across the country|coast to coast|national footprint|across north america)\b/i.test(text)) out.push('operates nationwide');
  const owned = text.match(/\b(a subsidiary of|a division of|(?:was |were |has been )?acquired by|portfolio company|private equity|publicly traded|NYSE|NASDAQ|Fortune 500)\b/i);
  if (owned) out.push(`site says "${owned[1].trim()}"`);
  const chiefs = new Set([...text.matchAll(/\b(Chief [A-Z][a-z]+(?: [A-Z][a-z]+)? Officer|Executive Vice President|Senior Vice President)\b/g)].map(m => m[1]));
  if (chiefs.size >= 2) out.push(`a leadership team with ${[...chiefs].slice(0, 2).join(' and ')}`);
  return out;
}

function extractFacts(pages, bucket) {
  const html = pages.map(p => p.html).join('\n');
  const text = pages.map(p => p.text).join(' \n ');
  const facts = {};

  const jsonld = pages.flatMap(p => p.jsonld);
  const biz = jsonld.find(o => /LocalBusiness|Organization|Dentist|Restaurant|Store|Service|Physician|Attorney|Accounting|Contractor|Plumber|Electrician|HVAC|AutoRepair|BeautySalon|HealthAndBeauty|MedicalBusiness|ProfessionalService|FoodEstablishment/i.test([].concat(o['@type'] || []).join(' ')));
  const thisYear = new Date().getUTCFullYear();

  let founded = null;
  const fy = biz?.foundingDate && String(biz.foundingDate).match(/(18|19|20)\d{2}/);
  if (fy) founded = Number(fy[0]);
  if (!founded) {
    const m = text.match(/\b(?:since|established(?: in)?|est\.?|founded(?: in)?|serving [^.]{0,40} since|in business since|opened(?: our doors)? in)\s*(?:in\s*)?((?:18|19|20)\d{2})\b/i);
    if (m) founded = Number(m[1]);
  }
  if (founded && founded > 1800 && founded <= thisYear) {
    facts.founded = founded;
    facts.years_in_business = thisYear - founded;
  } else {
    const m = text.match(/\b(?:over|more than|nearly|almost)?\s*(\d{1,3})\+?\s+years\s+(?:of\s+)?(?:experience|in business|serving|in the business)/i);
    if (m && Number(m[1]) >= 3 && Number(m[1]) < 150) facts.years_claimed = Number(m[1]);
  }
  if (/family[- ]owned|family[- ]run|family business|third[- ]generation|second[- ]generation|fourth[- ]generation/i.test(text)) facts.family_owned = true;
  if (/locally[- ]owned|independently[- ]owned|veteran[- ]owned|woman[- ]owned|women[- ]owned/i.test(text)) facts.locally_owned = true;

  const team = text.match(/\bteam of (?:over |more than )?(\d{1,3})\b/i) || text.match(/\b(\d{1,3})\s+(?:full[- ]time )?(?:employees|staff members|team members)\b/i);
  if (team) facts.team_size_text = Number(team[1]);
  const emp = biz?.numberOfEmployees;
  if (emp) {
    const v = typeof emp === 'object' ? (emp.value || emp.maxValue || emp.minValue) : emp;
    if (Number(v)) facts.team_size_text = Number(v);
  }

  facts.big_signals = bigCompanySignals(text);

  facts.booking_tools = detect(BOOKING_TOOLS, html);
  facts.chat_tools = detect(CHAT_TOOLS, html);
  facts.shop_tools = detect(SHOP_TOOLS, html);
  facts.platform = detect(PLATFORMS, html)[0] || null;

  if (/\bcall (?:us |our office |the office )?(?:today )?(?:to|for) (?:schedule|book|make|set up|request|an? appointment|reserve|order|place)/i.test(text)
    || /\bappointments? (?:by|via) (?:phone|calling)\b|\bcall (?:for|to make) (?:an )?appointment/i.test(text)) facts.phone_first = true;
  if (/request (?:a |your )?(?:free )?(?:quote|estimate)|free estimates?|get (?:a |your )?(?:free )?(?:quote|estimate)/i.test(text)) facts.quote_requests = true;
  if (/(?:now hiring|we['’]re hiring|we are hiring|join our team|careers|employment opportunities|help wanted)/i.test(text)) facts.hiring = true;
  if (/new patient (?:forms?|paperwork)|intake forms?|download (?:our |the )?(?:forms?|application)|printable (?:forms?|application)/i.test(text)
    || pages.some(p => p.links.some(l => /\.pdf($|\?)/i.test(l.url) && /form|intake|application|registration|paperwork/i.test(l.url + ' ' + l.label)))) facts.paper_forms = true;
  if (/catering|private (?:events?|parties|dining)|event space|book (?:an|your) event/i.test(text) && bucket === 'food') facts.catering = true;
  if (/online ordering|order online|order now/i.test(text)) facts.online_ordering = true;
  if (/\bfaq\b|frequently asked/i.test(text)) facts.has_faq = true;

  const years = [...text.matchAll(/(?:©|copyright|&copy;)\s*(?:copyright\s*)?(\d{4})(?:\s*[-–]\s*(\d{4}))?/gi)]
    .map(m => Number(m[2] || m[1]))
    .filter(y => y >= 1995 && y <= thisYear);
  if (years.length) facts.site_year = Math.max(...years);

  const socials = new Set();
  for (const p of pages) for (const l of p.links) {
    if (/facebook\.com\/(?!sharer|share|dialog|plugins|tr\b)/i.test(l.url)) socials.add('facebook');
    if (/instagram\.com\//i.test(l.url)) socials.add('instagram');
    if (/linkedin\.com\/company/i.test(l.url)) socials.add('linkedin');
    if (/(tiktok|youtube)\.com\//i.test(l.url)) socials.add(/tiktok/i.test(l.url) ? 'tiktok' : 'youtube');
  }
  facts.socials = [...socials];

  const home = pages[0];
  if (home?.description) facts.description = home.description.slice(0, 300);
  // A sentence or two in their own words, preferring the About page.
  const aboutPage = pages.find(p => /about|our-?story|who-?we-?are/i.test(p.url)) || home;
  const para = (aboutPage?.paragraphs || []).find(t => /\b(we|our|family|since|founded|offer|provide|serv)/i.test(t)) || (home?.paragraphs || [])[0];
  if (para) facts.about = para.slice(0, 400);
  if (home?.title) facts.site_title = home.title.slice(0, 140);
  return facts;
}

// Does the site actually belong to this business? Guards against the
// registry's filed email pointing at an accountant's or agent's domain.
// Words that show up in lots of business names and websites, so a match on
// one of them proves nothing ("Call the Frog" vs "Call the Whale").
const GENERIC_NAME_WORDS = /^(services|service|group|associates|company|center|shop|studio|llc|inc|call|home|homes|best|first|quality|professional|professionals|pros?|solutions|enterprises|management|consulting|construction|contractors?|plumbing|heating|cooling|electric|electrical|roofing|landscaping|cleaning|auto|repair|care|health|family|united|american|national|global|general|premier|elite|custom|total|complete|express|plus|works|new|england|connecticut)$/;
function siteMatchesBusiness(pages, name) {
  const all = nameKey(name).split(' ').filter(w => w.length > 3);
  const words = all.filter(w => !GENERIC_NAME_WORDS.test(w));
  if (!all.length) return true;
  const hay = pages.slice(0, 3).map(p => `${p.title} ${p.text.slice(0, 5000)}`).join(' ').toLowerCase();
  // A name made only of common words has to appear whole.
  if (!words.length) return hay.includes(nameKey(name));
  const hits = words.filter(w => hay.includes(w)).length;
  // One or two distinctive words: all of them. More: at least two and half.
  return words.length <= 2 ? hits === words.length : hits >= 2 && hits / words.length >= 0.5;
}

// The site has to be about a business in the same place. A site that gives
// an address in another state and never mentions ours is a different
// business, even with a similar name. A site that says nothing about where
// it is can't be ruled out on place alone.
const AMBIGUOUS_STATE_NAMES = new Set(['WA', 'DC', 'GA', 'IN', 'ME', 'OR']); // "Washington St", "Indiana Jones", "or"...
function siteMatchesPlace(pages, p) {
  const state = stateOf(p);
  const text = pages.slice(0, 4).map(x => `${x.title || ''} ${x.text || ''}`).join(' ');
  const lower = text.toLowerCase();
  const town = String(p.town || '').toLowerCase().trim();
  const name = String(STATE_NAMES[state] || '').toLowerCase();
  if (town && new RegExp(`\\b${town.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) return true;
  if (name && lower.includes(name)) return true;
  if (new RegExp(`(,|\\s)${state}\\.?\\s+\\d{5}\\b`).test(text)) return true;
  const elsewhere = Object.entries(STATE_NAMES).some(([code, full]) => code !== state && (
    new RegExp(`(,|\\s)${code}\\.?\\s+\\d{5}\\b`).test(text) ||
    (!AMBIGUOUS_STATE_NAMES.has(code) && new RegExp(`\\b${full.toLowerCase()}\\b`).test(lower))));
  return !elsewhere;
}
// Same name and same place.
function siteIsTheirs(pages, p) {
  return siteMatchesBusiness(pages, p.name) && siteMatchesPlace(pages, p);
}

// Rank every address we found. Higher is better.
function rankEmails(emails, { domain, people }) {
  const names = (people || []).map(p => {
    const parts = p.name.toLowerCase().split(/\s+/);
    return { first: parts[0], last: parts[parts.length - 1], person: p };
  });
  return emails
    .map(email => {
      const [local, dom] = email.split('@');
      const onDomain = domain && (dom === domain || dom.endsWith(`.${domain}`) || domain.endsWith(`.${dom}`));
      const free = FREEMAIL.has(dom);
      let score = 0;
      let why = '';
      let person = null;
      const lp = local.replace(/[^a-z]/g, '');
      const nameHit = names.find(n => lp === n.first || lp.startsWith(n.first + n.last) || lp === n.first[0] + n.last || lp === `${n.first}${n.last[0]}` || local === `${n.first}.${n.last}` || (lp.includes(n.last) && n.last.length > 3));
      if (nameHit && (onDomain || free)) { score = 100; why = `${nameHit.person.name}'s own address`; person = nameHit.person; }
      else if (onDomain && ROLE_RANK[local] != null) { score = ROLE_RANK[local]; why = `${local}@ on their own domain`; }
      else if (onDomain && /^[a-z]+(\.[a-z]+)?$/.test(local)) { score = 70; why = 'a person\'s address on their own domain'; }
      else if (onDomain) { score = 50; why = 'on their own domain'; }
      else if (free) { score = 64; why = 'listed on their own website'; }
      else { score = 12; why = 'different domain (maybe their web designer)'; }
      return { email, score, why, onDomain: !!onDomain, free, person };
    })
    .sort((a, b) => b.score - a.score);
}

async function hasMx(domain, resolver = dns) {
  if (!domain) return false;
  try {
    const mx = await resolver.resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch (e) {
    return false;
  }
}

// Crawl home + up to 4 relevant subpages on the same site.
async function crawlSite(website, fetchImpl = fetch) {
  const first = await fetchPage(website, fetchImpl);
  const home = extractPage(first.html, first.url);
  const pages = [home];
  const seen = new Set([home.url.replace(/\/$/, '')]);
  const candidates = home.links
    .filter(l => l.host === home.host && (SUBPAGE_HINT.test(l.path) || SUBPAGE_HINT.test(l.label)))
    .sort((a, b) => Number(/contact/i.test(b.path + b.label)) - Number(/contact/i.test(a.path + a.label)));
  for (const l of candidates) {
    const key = l.url.replace(/\/$/, '');
    if (seen.has(key) || pages.length >= 5) continue;
    seen.add(key);
    try {
      const pg = await fetchPage(l.url, fetchImpl);
      pages.push(extractPage(pg.html, pg.url));
    } catch (e) { /* a dead subpage isn't fatal */ }
  }
  return pages;
}

/**
 * Enrich one prospect. Returns a patch for the prospect row.
 * opts: { fetchImpl, resolver, useRegistry }
 */
const FREE_MAIL = /^(gmail|yahoo|aol|hotmail|outlook|icloud|comcast|att|sbcglobal|snet|cox|verizon|optonline|msn|live|me|ymail|protonmail|charter)\./i;
const ROLE_LOCAL = /^(info|questions|contact|hello|office|admin|support|investorrelations|ir|legal|ars|compliance|marketing|sales|press|media)$/i;
function emailBelongsElsewhere(email, source, name) {
  const [local, dom] = String(email).toLowerCase().split('@');
  if (!dom || FREE_MAIL.test(dom)) return false;
  if (source !== 'registry' && !ROLE_LOCAL.test(local)) return false;
  const host = dom.replace(/\.[a-z.]+$/, '').replace(/[^a-z0-9]/g, '');
  const tokens = String(name).toLowerCase().replace(/\b(llc|inc|co|corp|company|limited|liability|the|and|of|services?|group)\b/g, ' ')
    .split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  const localClean = local.replace(/[^a-z0-9]/g, '');
  // The owner the business is named after, at their own or day-job address, is still them.
  if (tokens.some(t => t.length >= 4 && localClean.includes(t))) return false;
  return !tokens.some(t => host.includes(t));
}

async function enrichProspect(p, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const resolver = opts.resolver || dns;
  const patch = { facts: { ...(p.facts || {}) }, enriched_at: new Date().toISOString(), last_error: null };
  const notes = [];

  let pages = [];
  let website = p.website;
  if (website && PARKED_SITE.test(domainOf(website) || '')) {
    notes.push(`Listed website is a parked domain (${domainOf(website)}); ignored it`);
    website = null;
    patch.website = null;
    patch.domain = null;
  }
  // No website on file: look for one, and keep it only if the site is clearly theirs.
  if (!website && opts.findWebsite !== false) {
    try {
      const found = await findWebsite(p.name, p.town, fetchImpl);
      if (found) {
        const trial = await crawlSite(found, fetchImpl);
        if (siteIsTheirs(trial, p)) {
          pages = trial;
          website = normalizeUrl(trial[0].url) || found;
          patch.website = website;
          patch.domain = domainOf(website);
          notes.push(`Found their website by searching: ${patch.domain}`);
        }
      }
    } catch (err) { /* searching is best-effort */ }
  }
  if (website && !pages.length) {
    try {
      pages = await crawlSite(website, fetchImpl);
      website = normalizeUrl(pages[0].url) || website;
      patch.website = website;
      patch.domain = domainOf(website);
    } catch (err) {
      notes.push(`Website didn't load (${err.message})`);
      if (p.source === 'registry') { patch.website = null; patch.domain = null; }
    }
  }

  if (pages.length && p.source === 'registry' && !siteIsTheirs(pages, p)) {
    // The filed email's domain is someone else's site (often their accountant).
    notes.push('Filed email points at a different business\'s website; ignored it');
    pages = [];
    patch.website = null;
    patch.domain = null;
    if (p.email_source === 'registry') { patch.email = null; patch.email_source = null; patch.email_confidence = null; }
  }

  const domain = patch.domain !== undefined ? patch.domain : p.domain;
  const people = pages.length ? findPeople(pages.map(x => x.text).join(' \n '), pages.flatMap(x => x.jsonld)) : [];
  if (pages.length) Object.assign(patch.facts, extractFacts(pages, p.bucket));
  patch.facts.pages_read = pages.map(x => x.url);
  // A website only counts if it loaded and is clearly this business.
  const listed = patch.website !== undefined ? patch.website : p.website;
  if (pages.length && !siteIsTheirs(pages, p)) {
    notes.push(`${domainOf(listed) || 'The listed website'} loaded, but it's for a different business${siteMatchesBusiness(pages, p.name) ? ' in another place' : ''}; not using it`);
    pages = [];
    patch.facts.pages_read = [];
  }
  patch.website_verified = pages.length > 0;
  // A filed (or role) email at a domain that has nothing to do with this
  // business belongs to someone else: their accountant, a franchisor, a
  // filing agent, an employer. Don't write to it.
  const email = patch.email !== undefined ? patch.email : p.email;
  const emailSource = patch.email_source !== undefined ? patch.email_source : p.email_source;
  if (!patch.website_verified && email && emailBelongsElsewhere(email, emailSource, p.name)) {
    notes.push(`${email} doesn't look like this business's own address; not using it`);
    patch.email = null; patch.email_source = null; patch.email_confidence = null;
  }
  if (!patch.website_verified && listed) {
    patch.facts.website_unverified = listed;
    patch.website = null;
    patch.domain = null;
  }

  // CT registry: filed email + principals (owners/members/officers).
  let registry = p.registry || null;
  if (opts.useRegistry !== false) {
    try {
      if (!registry) registry = await registryLookup(p.name, p.town, fetchImpl);
      // A business found on the map only matches a filing in its own city
      // and state; otherwise "Flour" in Cambridge picks up a CT B&B's owner.
      if (registry && p.source !== 'registry' && !registryIsLocal(registry, p)) {
        notes.push(`Registry has a "${registry.name}" in ${registry.city || 'another town'}; not the same business`);
        registry = null;
      }
      if (registry) {
        patch.registry = registry;
        if (registry.naics) patch.facts.naics = registry.naics;
        if (registry.type) patch.facts.business_type = registry.type;
        if (registry.registered) {
          const y = Number(String(registry.registered).slice(0, 4));
          if (y > 1800) patch.facts.registered_year = y;
        }
        if (!registry.principals) {
          registry.principals = await registryPrincipals(registry.id, fetchImpl).catch(() => []);
          patch.registry = registry;
        }
      }
    } catch (err) {
      notes.push(`Registry lookup failed (${err.message})`);
    }
  }
  for (const pr of registry?.principals || []) {
    if (!people.some(x => nameKey(x.name) === nameKey(pr.name))) {
      people.push({ name: pr.name, role: (pr.title || 'principal').toLowerCase(), how: 'state filing' });
    }
  }
  // Every name keeps its source: the page it was read on, or the filing's
  // id. A website name we can't point back to a page isn't used.
  for (const x of people) {
    if (x.how === 'state filing') x.business_id = registry?.id || null;
    else x.url = x.url || (pages.find(pg => String(pg.text || '').includes(x.name)) || {}).url || null;
  }
  for (let i = people.length - 1; i >= 0; i--) if (!(people[i].how === 'state filing' ? people[i].business_id : people[i].url)) people.splice(i, 1);
  patch.facts.people = people.slice(0, 6);

  // Collect every candidate address.
  const found = new Set(pages.flatMap(x => x.emails));
  if (p.email && p.email_source !== 'registry') found.add(p.email);
  const ranked = rankEmails([...found], { domain, people });

  // The registry's filed address: trust it when it's on their domain or
  // a free-mail address (owner's personal inbox); not when it's another
  // company's domain (agent, accountant, lawyer).
  const regEmail = registry?.email && cleanEmail(registry.email);
  if (regEmail && !found.has(regEmail)) {
    const dom = regEmail.split('@')[1];
    const onDomain = domain && dom === domain;
    if (onDomain || FREEMAIL.has(dom)) {
      const r = rankEmails([regEmail], { domain, people })[0];
      ranked.push({ ...r, score: Math.max(r.score - 4, 45), why: `${r.why}; filed with the CT Secretary of State`, registry: true });
      ranked.sort((a, b) => b.score - a.score);
    }
  }
  patch.facts.emails_found = ranked.slice(0, 6).map(r => ({ email: r.email, why: r.why, score: r.score }));

  let best = ranked.find(r => r.score >= 30) || null;
  if (best) {
    const dom = best.email.split('@')[1];
    const mx = FREEMAIL.has(dom) ? true : await hasMx(dom, resolver);
    if (!mx) {
      notes.push(`${best.email} has no mail server (MX); skipped`);
      best = ranked.filter(r => r !== best && r.score >= 30)[0] || null;
    }
  }

  // Pick who to address.
  const owner = people.find(x => /owner|founder|president|proprietor|ceo|principal|member|manager|partner|dmd|dds/i.test(x.role || '')) || people[0] || null;
  const person = best?.person || owner;

  if (best) {
    patch.email = best.email;
    patch.email_source = best.registry ? 'registry' : (p.email === best.email && p.email_source === 'osm' ? 'osm' : 'website');
    // The page the address is on, so the desk can link to it.
    patch.email_url = patch.email_source === 'website' ? (pages.find(pg => (pg.emails || []).includes(best.email)) || {}).url || null : null;
    patch.email_confidence = best.score >= 55 || best.free ? 'high' : 'medium';
  } else if (owner && domain && !FREEMAIL.has(domain) && await hasMx(domain, resolver)) {
    // No address published anywhere. first@domain is the most common
    // small-business pattern, but it's a guess: always held for review.
    const f = firstName(owner.name);
    if (f) {
      patch.email = `${f.toLowerCase()}@${domain}`;
      patch.email_source = 'guess';
      patch.email_confidence = 'low';
      notes.push(`No address published; guessed ${patch.email} from ${owner.name}'s name. Check before sending.`);
    }
  } else if (!p.email) {
    patch.email = null;
  }

  if (person) {
    patch.contact_name = person.name;
    patch.contact_title = person.role
      ? person.role.replace(/\b\w/g, c => c.toUpperCase()).replace(/\b(Dmd|Dds|Cpa|Ceo|Esq|Dvm)\b/g, m => m.toUpperCase())
      : null;
  }

  // A phone number keeps its source too: the page of their site it's on.
  const phoneUrl = phoneOnPages(p.phone, pages);
  if (phoneUrl) patch.phone_url = phoneUrl;

  patch.facts.enrich_notes = notes;
  return patch;
}

module.exports = { bigCompanySignals, emailBelongsElsewhere, cleanPersonName, registryIsLocal, siteMatchesPlace, siteIsTheirs, GENERIC_NAME_WORDS,
  findWebsite, fetchPage, extractPage, extractFacts, findPeople, phoneOnPages, rankEmails, cleanEmail, decodeCfEmail,
  siteMatchesBusiness, crawlSite, enrichProspect, hasMx,
};
