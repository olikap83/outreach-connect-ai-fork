// What goes into the class CRM for each business. Classmates read these,
// so every entry has to say something real about the business: what it
// does, how big it is, where its site is, who we'd talk to, and why it's
// worth a look. No boilerplate.
//
// Also decides whether a business has enough substance to post at all.
// Street addresses, numbered holding companies and opaque shell names with
// nothing else known stay on the student's own desk and never reach the CRM.

const ADDRESS_NAME = /^\d+\s+[\w.' -]*\b(road|rd|street|st|avenue|ave|lane|ln|drive|dr|way|route|rt|highway|hwy|turnpike|tpke|boulevard|blvd|place|pl|court|ct|circle|hill|pike)\b/i;
const OPAQUE_NAME = /^([A-Z]{2,5}|[A-Z]{1,4}[\s-]?\d{2,}|\w+\s?\d{3,})$/;

const { sourceUrl } = require('./factsources');

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

// Where the emails stand, in one line, so the CRM page matches what went out.
const day = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
function emailStatus(p) {
  if (!p.email) return 'No email address found yet.';
  if (!p.sent_at) return 'Intro email drafted; not sent yet.';
  const parts = [`Intro email sent ${day(p.sent_at)} to ${p.email}.`];
  if (p.followup_at) parts.push(`Followed up ${day(p.followup_at)}.`);
  if (p.status === 'bounced') parts.push('The email bounced.');
  else if (p.status === 'not_interested') parts.push(`Wrote back ${p.replied_at ? day(p.replied_at) : ''} and said no thanks.`.replace('  ', ' '));
  else if (p.replied_at && p.status === 'replied') parts.push(`Wrote back ${day(p.replied_at)}.`);
  else parts.push('No reply yet.');
  return parts.join(' ');
}

// "Found by Maya Lin's outreach research", or without a name when none is set.
function foundBy(settings) {
  const name = String((settings && settings.sender_name) || '').trim();
  return name ? `Found by ${name}'s outreach research` : 'Found by outreach research';
}

// Stored notes end with the status line from when they were written; swap in
// today's. Matches the line whoever's name is in it (or none).
function crmNotesNow(p, settings = {}) {
  const notes = p.crm_notes || buildCrmNotes(p, settings);
  return notes.replace(/(Found by [^\n]*?outreach research[^.\n]*\.)[^\n]*$/, `$1 ${emailStatus(p)}`).slice(0, 3900);
}

// Every line carries the link it came from, so a classmate can check it.
// A fact with no link isn't posted.
function buildCrmNotes(p, settings = {}) {
  const f = p.facts || {};
  const lines = [];
  const src = key => sourceUrl(p, key);
  const add = (text, url) => { if (text && url) lines.push(`${text} (source: ${url})`); };

  const aboutKey = f.about ? 'about' : f.description ? 'description' : null;
  const about = aboutKey && f[aboutKey];
  const industry = industryText(p);
  if (about) add(`What they do: ${clip(about, 400)}`, src(aboutKey));
  else if (industry) add(`What they do: ${industry} (${f.naics ? 'the industry they filed with the state' : 'how their map listing describes them'})`, src('category'));
  if (about && industry && !about.toLowerCase().includes(String(industry).toLowerCase().split(' ')[0])) add(`Industry: ${industry}`, src('category'));

  if (f.team_size_text) add(`Size: about ${f.team_size_text} people, per their website`, src('team_size_text'));
  else {
    const principals = (f.people || []).filter(x => x.how === 'state filing').length;
    if (principals) add(`Size: ${principals === 1 ? 'one person' : `${principals} owners/officers`} listed on the state filing (headcount not public)`, src('people_on_filing'));
  }
  const year = new Date().getUTCFullYear();
  if (f.founded) add(`In business since: ${f.founded} (${year - f.founded} years), per their website`, src('founded'));
  else if (f.years_claimed) add(`In business: ${f.years_claimed}+ years, per their website`, src('years_claimed'));
  else if (f.registered_year) add(`In business since: registered with the CT Secretary of the State in ${f.registered_year}`, src('filing'));

  const addr = p.address && p.address === p.address.toUpperCase()
    ? p.address.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase())
    : (p.address || '');
  const hasTown = p.town && addr.toLowerCase().includes(String(p.town).toLowerCase());
  const where = [addr || null, p.town && !hasTown ? p.town : null].filter(Boolean).join(', ') + (addr || p.town ? `, ${String(p.state || 'CT').toUpperCase()}` : '');
  const miles = p.miles_from_storrs != null ? ` (${Math.round(p.miles_from_storrs)} mi from Storrs)` : '';
  if (where) add(`Where: ${where}${miles}`, src('address'));

  const url = websiteUrl(p);
  if (url && p.website_verified !== false) lines.push(`Website: ${url}`);

  if (p.contact_name) add(`Contact: ${p.contact_name}${p.contact_title ? ` (${p.contact_title})` : ''}`, src('contact'));
  if (p.email) add(`Email: ${p.email}`, src('email'));
  if (p.phone) add(`Phone: ${p.phone}`, src('phone'));

  const signals = [];
  const signal = (text, key) => { const u = src(key); if (u) signals.push(`${text} (${u})`); };
  if (f.phone_first) signal('books appointments/orders by phone', 'phone_first');
  if (f.quote_requests) signal('takes quote requests through their site', 'quote_requests');
  if (f.paper_forms) signal('uses paper or PDF forms', 'paper_forms');
  if (f.catering) signal('takes catering/event orders', 'catering');
  // A page that seems to mention a dozen booking and ordering systems is a
  // detection mistake (theme code, plugin lists), not a real stack: skip it.
  const tools = ['booking_tools', 'shop_tools'].flatMap(k => (f[k] || []).map(t => [k, t]));
  if (tools.length <= 3) for (const [k, t] of tools) signal(`already uses ${t}`, `${k}:${t}`);
  if (f.family_owned) signal('family-owned', 'family_owned');
  if (signals.length) lines.push(`Worth noting: ${signals.join('; ')}`);

  lines.push(`${foundBy(settings)}${p.fit_score != null ? ` (fit ${p.fit_score}/100)` : ''}. ${emailStatus(p)}`);
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

module.exports = { cardLine, buildCrmNotes, emailStatus, crmNotesNow, hasSubstance, websiteUrl, industryText, headcountText, shortName, ADDRESS_NAME, OPAQUE_NAME };
