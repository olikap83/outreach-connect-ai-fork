// What goes into the class CRM for each business. Classmates read these,
// so every entry has to say something real about the business: what it
// does, how big it is, where its site is, who we'd talk to, and why it's
// worth a look. No boilerplate.
//
// Also decides whether a business has enough substance to post at all.
// Street addresses, numbered holding companies and opaque shell names with
// nothing else known stay on Soham's desk and never reach the CRM.

const ADDRESS_NAME = /^\d+\s+[\w.' -]*\b(road|rd|street|st|avenue|ave|lane|ln|drive|dr|way|route|rt|highway|hwy|turnpike|tpke|boulevard|blvd|place|pl|court|ct|circle|hill|pike)\b/i;
const OPAQUE_NAME = /^([A-Z]{2,5}|[A-Z]{1,4}[\s-]?\d{2,}|\w+\s?\d{3,})$/;

function shortName(name) {
  const n = String(name || '')
    .replace(/,?\s*\b(limited partnership|limited liability( company| partnership)?|l\.?\s?l\.?\s?c|inc|incorporated|corp|corporation|co|company|ltd|limited|p\.?\s?c|p\.?\s?l\.?\s?l\.?\s?c|l\.?\s?l\.?\s?p|l\.?\s?p|ltd\.? liability co)\b\.?\s*$/i, '')
    .replace(/,?\s*\b(limited liability|limited partnership|l\.?\s?l\.?\s?c|inc|p\.?\s?c)\b\.?\s*$/i, '')
    .replace(/[,\s]+$/, '')
    .trim();
  return n || String(name || '');
}

function websiteUrl(p) {
  if (p.website) return /^https?:/i.test(p.website) ? p.website : `https://${p.website}`;
  if (p.domain) return `https://${p.domain}`;
  return null;
}

function industryText(p) {
  const f = p.facts || {};
  if (f.naics) {
    const label = String(f.naics).replace(/\s*\(\d+\)\s*$/, '').trim();
    if (label) return label;
  }
  return p.category || null;
}

function sizeText(p) {
  const f = p.facts || {};
  if (f.team_size_text) return `About ${f.team_size_text} people (from their website)`;
  const principals = (f.people || []).filter(x => x.how === 'state filing').length;
  const freemail = p.email && /@(gmail|yahoo|aol|hotmail|outlook|icloud|comcast|att|sbcglobal|snet|cox|verizon|optonline)\./i.test(p.email);
  if (principals === 1 && freemail && !p.website) return 'Small and owner-run: one person on the state filing, personal email, no website';
  if (principals === 1) return 'One person listed on the state filing (headcount not public)';
  if (principals > 1) return `${principals} owners/officers listed on the state filing`;
  return null;
}

function sinceText(p) {
  const f = p.facts || {};
  const year = new Date().getUTCFullYear();
  if (f.founded) return `${f.founded} (${year - f.founded} years), per their website`;
  if (f.years_claimed) return `${f.years_claimed}+ years in business, per their website`;
  if (f.registered_year) return `registered with the CT Secretary of the State in ${f.registered_year}`;
  return null;
}

// True when a classmate could read the entry and know what this business is.
function hasSubstance(p) {
  const name = shortName(p.name);
  if (ADDRESS_NAME.test(name)) return false;
  const f = p.facts || {};
  const known = !!(websiteUrl(p) || f.description || f.about);
  if (known) return true;
  if (OPAQUE_NAME.test(name.trim())) return false;
  // Registry-only: needs a real industry and a named person to count.
  return !!(industryText(p) && p.contact_name && p.email);
}

// Cut long descriptions at a sentence (or at least a word), never mid-word.
function clip(text, max) {
  const t = String(text).trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = cut.lastIndexOf('. ');
  if (end > max * 0.5) return cut.slice(0, end + 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:–-]+$/, '') + '…';
}

function buildCrmNotes(p) {
  const f = p.facts || {};
  const lines = [];
  const about = f.about || f.description;
  const industry = industryText(p);
  if (about) lines.push(`What they do: ${clip(about, 400)}`);
  else if (industry) lines.push(`What they do: ${industry} (the industry they filed with the state)`);
  if (about && industry && !about.toLowerCase().includes(String(industry).toLowerCase().split(' ')[0])) lines.push(`Industry: ${industry}`);

  const size = sizeText(p);
  if (size) lines.push(`Size: ${size}`);
  const since = sinceText(p);
  if (since) lines.push(`In business since: ${since}`);
  const addr = p.address && p.address === p.address.toUpperCase()
    ? p.address.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase())
    : (p.address || '');
  const hasTown = p.town && addr.toLowerCase().includes(String(p.town).toLowerCase());
  const where = [addr || null, p.town && !hasTown ? p.town : null].filter(Boolean).join(', ') + (addr || p.town ? `, ${String(p.state || 'CT').toUpperCase()}` : '');
  const miles = p.miles_from_storrs != null ? ` (${Math.round(p.miles_from_storrs)} mi from Storrs)` : '';
  if (where) lines.push(`Where: ${where}${miles}`);

  const url = websiteUrl(p);
  if (url) lines.push(`Website: ${url}`);
  else if (f.website_unverified) lines.push(`Website: none confirmed (${f.website_unverified} is listed for them but didn't load or isn't theirs)`);
  else lines.push('Website: none found');

  const source = { website: 'from their website', registry: 'filed with the CT Secretary of the State', osm: 'from OpenStreetMap', manual: 'added by hand', guess: 'a guess from the owner\'s name, unverified' }[p.email_source] || '';
  if (p.contact_name || p.email) {
    lines.push(`Contact: ${[p.contact_name, p.contact_title ? `(${p.contact_title})` : null].filter(Boolean).join(' ')}${p.email ? `${p.contact_name ? ', ' : ''}${p.email}${source ? ` (${source})` : ''}` : ''}`);
  }
  if (p.phone) lines.push(`Phone: ${p.phone}`);

  const signals = [];
  if (f.phone_first) signals.push('books appointments/orders by phone');
  if (f.quote_requests) signals.push('takes quote requests through their site');
  if (f.paper_forms) signals.push('uses paper or PDF forms');
  if (f.hiring) signals.push('hiring right now');
  if (f.catering) signals.push('takes catering/event orders');
  const tools = [...(f.booking_tools || []), ...(f.shop_tools || [])];
  if (tools.length) signals.push(`already uses ${tools.join(', ')}`);
  if (f.family_owned) signals.push('family-owned');
  if (signals.length) lines.push(`Worth noting: ${signals.join('; ')}`);

  lines.push(`Found by Soham's outreach research${p.fit_score != null ? ` (fit ${p.fit_score}/100)` : ''}. ${p.email ? 'Intro email drafted; not sent yet.' : 'No email address found yet.'}`);
  return lines.join('\n').slice(0, 3900);
}

// The one line a classmate sees on the business's card on the CRM board:
// what kind of business it is, short enough to fit (about 42 characters).
// Research can set p.card_line by hand; otherwise it comes from the
// state-filed industry or our own category.
const PLAIN_INDUSTRY = [
  [/nail salon/i, 'Nail salon'], [/beauty salon|barber/i, 'Hair & beauty salon'],
  [/full-service restaurant/i, 'Sit-down restaurant'], [/limited-service restaurant|snack|nonalcoholic beverage bar/i, 'Quick-service food spot'],
  [/caterer/i, 'Catering company'], [/mobile food/i, 'Food truck'], [/drinking places/i, 'Bar'],
  [/offices of dentists/i, 'Dental practice'], [/offices of physicians/i, "Physician's office"],
  [/mental health/i, 'Mental health practice'], [/physical, occupational|therapists/i, 'Therapy practice'],
  [/residential remodel/i, 'Home remodeling contractor'], [/single-family housing|236115|236118/i, 'Home builder'],
  [/commercial and institutional building/i, 'Commercial construction company'],
  [/electrical contractor/i, 'Electrical contractor'], [/plumbing|hvac|heating/i, 'Plumbing & heating contractor'],
  [/site preparation/i, 'Excavation & site work contractor'], [/finish carpentry|framing/i, 'Carpentry contractor'],
  [/landscaping/i, 'Landscaping company'], [/janitorial/i, 'Cleaning service'],
  [/accounting|bookkeeping|tax prep/i, 'Accounting & bookkeeping firm'], [/payroll/i, 'Payroll services company'],
  [/legal|offices of lawyers/i, 'Law & legal services'], [/real estate agents/i, 'Real estate brokerage'],
  [/insurance agenc/i, 'Insurance agency'], [/management consulting/i, 'Management consulting'],
  [/marketing consult|advertising/i, 'Marketing & advertising'], [/graphic design/i, 'Graphic design studio'],
  [/computer (systems|programming)/i, 'Software & IT services'], [/engineering services/i, 'Engineering firm'],
  [/architectural/i, 'Architecture firm'], [/environmental consult/i, 'Environmental consulting firm'],
  [/photograph/i, 'Photography studio'], [/child care/i, 'Childcare center'], [/fitness/i, 'Fitness studio'],
  [/pet care/i, 'Pet care & grooming'], [/automotive repair/i, 'Auto repair shop'], [/winer/i, 'Winery'],
  [/used merchandise/i, 'Consignment & resale shop'], [/clothing/i, 'Clothing store'], [/gasoline/i, 'Gas station & convenience store'],
  [/manufactur/i, 'Manufacturer'], [/general merchandise|miscellaneous retail/i, 'Retail shop'],
];
function cardLine(p) {
  if (p.card_line) return String(p.card_line).slice(0, 60);
  const naics = String((p.facts || {}).naics || '');
  for (const [re, text] of PLAIN_INDUSTRY) if (re.test(naics)) return text;
  const c = String(p.category || '').trim();
  return c ? c[0].toUpperCase() + c.slice(1) : 'Local business';
}

function headcountText(p) {
  const n = p.facts && p.facts.team_size_text;
  return n ? String(n) : null;
}

module.exports = { cardLine, buildCrmNotes, hasSubstance, websiteUrl, industryText, headcountText, shortName, ADDRESS_NAME, OPAQUE_NAME };
