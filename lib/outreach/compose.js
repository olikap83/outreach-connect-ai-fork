// Writes the emails.
//
// What gets replies from small-business owners: short, plainly from a real
// person, about THEIR business, and asking to learn rather than selling.
// Soham is a student who wants to hear how these businesses run, so every
// email is:
//
//   1. Who I am (accounting major at UConn) + how I found you, and one
//      thing I actually noticed about your business
//   2. Why I'm writing: Henkel/Andersen is big-company work; I want to
//      learn how a business like yours runs (to help, and to start my own
//      someday), with one real question about it
//   3. Connect.AI in a sentence, the optional form, and the ask for a call
//      either way. Close to Storrs? Offer to come by.
//   4. An easy way to say no.
//
// Plain text, no tracking pixel, one link. Wording rotates per business
// so a batch doesn't go out as identical copies.
//
// If GEMINI_API_KEY is set (free from Google AI Studio, no card), Gemini
// rewrites only the opening line using what was found on their site. Its
// output is checked and thrown away if it adds numbers or claims that
// weren't in the facts, gets long, or sounds like marketing.

const { BUCKETS } = require('./industries');
const { firstName, hashPick, stateOf, inClassArea, placeInWords, milesOf } = require('./util');

const TOOL_NAMES = {
  calendly: 'Calendly', acuity: 'Acuity', square: 'Square', vagaro: 'Vagaro', mindbody: 'Mindbody', schedulicity: 'Schedulicity',
  zocdoc: 'Zocdoc', nexhealth: 'NexHealth', localmed: 'LocalMed', solutionreach: 'Solutionreach', weave: 'Weave', opentable: 'OpenTable',
  resy: 'Resy', tock: 'Tock', toast: 'Toast', chownow: 'ChowNow', housecallpro: 'Housecall Pro', servicetitan: 'ServiceTitan',
  jobber: 'Jobber', setmore: 'Setmore', simplybook: 'SimplyBook', booksy: 'Booksy', glossgenius: 'GlossGenius', fresha: 'Fresha',
  janeapp: 'Jane', boulevard: 'Boulevard', practicebetter: 'Practice Better', wellnessliving: 'WellnessLiving', clover: 'Clover',
  shopify: 'Shopify', woocommerce: 'WooCommerce', bigcommerce: 'BigCommerce', ecwid: 'Ecwid', square_online: 'Square',
  tawk: 'a chat widget', intercom: 'Intercom', drift: 'Drift', livechat: 'LiveChat', tidio: 'Tidio', podium: 'Podium',
  birdeye: 'Birdeye', hubspot: 'HubSpot', zendesk: 'Zendesk',
};

function senderFirst(settings) {
  return firstName(settings.sender_name) || settings.sender_name || 'Soham';
}

// "Lacerta Group, LLC" → "Lacerta Group": nobody writes the legal suffix in an email.
function shortName(name) {
  const n = String(name || '')
    .replace(/,?\s*\b(limited partnership|limited liability( company| partnership)?|l\.?\s?l\.?\s?c|inc|incorporated|corp|corporation|co|company|ltd|limited|p\.?\s?c|p\.?\s?l\.?\s?l\.?\s?c|l\.?\s?l\.?\s?p|l\.?\s?p|ltd\.? liability co)\b\.?\s*$/i, '')
    .replace(/,?\s*\b(limited liability|limited partnership|l\.?\s?l\.?\s?c|inc|p\.?\s?c)\b\.?\s*$/i, '')
    .replace(/[,\s]+$/, '')
    .trim();
  return n || String(name || '');
}

function placeName(p) {
  return placeInWords(p);
}

// Facts worth one sentence, best first. Each is something we actually saw.
function factSentences(p) {
  const f = p.facts || {};
  const out = [];
  const thisYear = new Date().getUTCFullYear();
  if (f.founded && thisYear - f.founded >= 8) out.push(`I saw you've been at it since ${f.founded}, which is a long time to keep a business going.`);
  if (f.family_owned) out.push('I saw it\'s family-owned, which I always find interesting to learn about.');
  // Store tools (WooCommerce, Shopify...) only mean something for a shop or
  // restaurant; on a contractor's site they're usually leftover plugins.
  const sells = ['retail', 'food'].includes(p.bucket);
  const modern = [...(f.booking_tools || []), ...(sells ? f.shop_tools || [] : [])].map(k => TOOL_NAMES[k]).filter(Boolean);
  if (modern.length) out.push(`I noticed you use ${modern[0]}, and I'm curious how that's worked out for you.`);
  if (f.phone_first) out.push('I noticed most things still go through a phone call, which made me curious how you keep up with it.');
  if (f.quote_requests) out.push('I saw you take estimate requests through your site.');
  if (f.hiring) out.push('I also saw you\'re hiring, so I\'m guessing it\'s a busy stretch.');
  if (f.catering) out.push('I saw you take catering and event orders too.');
  if (!out.length && f.years_claimed >= 10) out.push(`I saw you've been doing this for over ${f.years_claimed} years.`);
  return out;
}

function templateOpener(p, seed, me) {
  const place = placeName(p);
  const found = [
    `I came across ${p.name} while looking at small businesses around ${place}.`,
    `I was looking at businesses around ${place} this week and ${p.name} stood out.`,
    `I found ${p.name} while looking at businesses around ${place}.`,
  ][hashPick(`${seed}:found`, 3)];
  const facts = factSentences(p);
  const fact = facts.length ? facts[hashPick(`${seed}:fact`, Math.min(2, facts.length))] : '';
  return [me, found, fact].filter(Boolean).join(' ');
}

function questionFor(p) {
  const b = BUCKETS[p.bucket] || BUCKETS.other;
  const cat = String(p.category || 'local').toLowerCase();
  return (b.question || BUCKETS.other.question).replace('{cat}', cat);
}

const ROLE_INBOX = /^(info|office|contact|hello|hi|admin|mail|service|services|sales|team|frontdesk|reception|appointments?|scheduling|inquiries|inquiry|support|help|owner|billing|accounts|orders)$/;

// Is this address someone other than the contact? ("kaker@" when we know "James Pennoyer")
function addressedToSomeoneElse(p) {
  if (!p.email || !p.contact_name) return false;
  const local = p.email.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  if (ROLE_INBOX.test(local)) return false;
  const parts = p.contact_name.toLowerCase().split(/\s+/).map(x => x.replace(/[^a-z]/g, '')).filter(x => x.length > 1);
  if (!parts.length) return false;
  const first = parts[0], last = parts[parts.length - 1];
  if (local.includes(first) || local.includes(last) || local === first[0] + last || local.startsWith(first[0] + last.slice(0, 4))) return false;
  // A free-mail address listed for the business is usually the owner's own, whatever it's called.
  return !/@(gmail|yahoo|aol|hotmail|outlook|icloud|comcast|att|sbcglobal|snet|cox|verizon|optonline)\./.test(p.email);
}

function greeting(p) {
  if (addressedToSomeoneElse(p)) return 'Hi there,';
  const f = firstName(p.contact_name);
  if (f && /dmd|dds|doctor|physician|dvm|chiropractor/i.test(p.contact_title || '')) {
    const last = p.contact_name.trim().split(/\s+/).pop();
    return `Hi Dr. ${last},`;
  }
  return f ? `Hi ${f},` : 'Hi there,';
}

function subjectFor(p, seed) {
  const place = placeName(p);
  const options = [
    `A question from a UConn student`,
    `Question about ${p.name}`,
    `UConn student hoping to learn from ${p.name}`,
  ];
  return options[hashPick(`${seed}:subject`, options.length)];
}

function composeInitial(p0, settings, opener) {
  const p = { ...p0, name: shortName(p0.name) };
  const seed = p0.id || p0.name;
  const place = placeName(p);
  const me = senderFirst(settings);
  const whoami = settings.sender_major
    ? `I'm ${me}, an ${settings.sender_major} major at UConn.`
    : `I'm ${me}, a student at UConn.`;

  const q = questionFor(p);
  const past = settings.past_internship, next = settings.next_internship;
  const why = past && next ? [
    `I'm reaching out mostly because I want to learn. I spent this past summer as an accounting intern at ${past} and I'll be at ${next} next summer, but that's all big-company work. I want to understand how a business like yours actually runs, partly so I can actually be useful and partly because I want to start my own someday. I'm curious ${q}.`,
    `Honestly, I'm trying to soak up as much as I can. I interned in accounting at ${past} this past summer and I'm headed to ${next} next summer, so I've seen how big companies work, but not much of how a business like yours runs day to day. I'd like to change that, both so I can actually help and because I want to start my own business one day. I'm curious ${q}.`,
  ][hashPick(`${seed}:why`, 2)] : [
    `I'm reaching out mostly because I'm always trying to learn. In my classes I see how businesses work on paper, but I don't get much of a look at how they actually run day to day. I'm curious ${q}.`,
    `Honestly, I'm writing because I'm always trying to learn. Most of what I study is how businesses look on paper, and I'd like to understand how they really run. I'm curious ${q}.`,
  ][hashPick(`${seed}:why`, 2)];

  const miles = milesOf(p);
  const near = stateOf(p) === 'CT' && miles != null && miles <= 30
    ? ` I'm in Storrs, so I could come by ${place} in person too.`
    : ' Happy to do it over the phone or Zoom, whatever is easiest.';
  const course = inClassArea(p)
    ? `I'm also in a UConn course called Connect.AI, where student teams work with small businesses in Connecticut and around New England and New York to find places AI could save them time, and then build it for free. If you're interested in helping us understand your business better, there's a short form at ${settings.apply_url} (about 3 minutes, and you get a free AI-readiness report). If you don't want to, no worries at all. I'd still really appreciate a 15-minute call.${near}`
    // Outside the class's area there's no program to offer; just the call.
    : `If you're open to it, I'd really appreciate a 15-minute call.${near}`;
  const aboutMe = settings.linkedin_url ? `If you want to know a bit more about me first, here's my LinkedIn: ${settings.linkedin_url}` : '';
  const no = 'And if now isn\'t a good time, just tell me and I won\'t bother you again.';

  const body = [
    greeting(p),
    opener ? `${whoami} ${opener}` : templateOpener(p, seed, whoami),
    why,
    course + (settings.offer_note ? ` ${settings.offer_note.trim()}` : ''),
    aboutMe,
    no,
    `Thanks,\n${settings.signature}`,
  ].filter(Boolean).join('\n\n');

  return { subject: subjectFor(p, seed), body };
}

function composeFollowup(p0, settings, originalSubject) {
  const p = { ...p0, name: shortName(p0.name) };
  const me = senderFirst(settings);
  const subject = /^re:/i.test(originalSubject || '') ? originalSubject : `Re: ${originalSubject || p.name}`;
  const body = [
    greeting(p),
    'Just bumping this in case it got buried. Even a 10-minute call would help me a lot; I\'m trying to learn how businesses like yours actually run, whether or not we ever work together.',
    `If you'd rather, the form is at ${settings.apply_url} (about 3 minutes, with a free AI-readiness report). And if now isn't a good time, no problem at all.`,
    `Thanks,\n${me}`,
  ].join('\n\n');
  return { subject, body };
}

// ---------- optional Gemini polish ----------

const BANNED = /(revolutioniz|synerg|leverag|cutting[- ]edge|game[- ]chang|unlock|empower|hope this (email|message) finds you|i wanted to reach out|elevate|seamless|streamline your|transform your|in today's|!|https?:|www\.)/i;

function factBlock(p) {
  const f = p.facts || {};
  return JSON.stringify({
    business: p.name,
    town: p.town,
    category: p.category,
    owner_or_contact: p.contact_name || null,
    site_title: f.site_title || null,
    site_description: f.description || null,
    founded: f.founded || null,
    family_owned: !!f.family_owned,
    books_by_phone: !!f.phone_first,
    takes_quote_requests: !!f.quote_requests,
    hiring: !!f.hiring,
    tools_on_site: [...(f.booking_tools || []), ...(f.shop_tools || [])].map(k => TOOL_NAMES[k]).filter(Boolean),
  });
}

function validOpener(text, p) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  const words = t.split(/\s+/).length;
  if (words < 8 || words > 48) return false;
  if ((t.match(/[.?]/g) || []).length > 3) return false;
  if (BANNED.test(t)) return false;
  // Every number in the output must appear in the facts we gave it.
  const allowed = factBlock(p);
  for (const n of t.match(/\d+/g) || []) if (!allowed.includes(n)) return false;
  if (!t.includes(p.name.split(' ')[0]) && !/your (business|shop|practice|firm|team|restaurant|office)/i.test(t)) return false;
  return true;
}

async function geminiOpener(p, fetchImpl = fetch) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const prompt = `You write the first 1-2 sentences of a short, friendly email from a UConn college student to a small local business owner.
Facts we found on the business's own website (use ONLY these, never invent anything):
${factBlock(p)}

Write how the student came across the business and mention ONE specific, real detail from the facts above in a natural way.
Rules: plain everyday language, like a real student would write. No flattery beyond one light touch. No exclamation marks. No links.
No marketing words (streamline, leverage, unlock, transform, elevate, seamless). Do not mention AI, the course, or any offer. Max 40 words.
Return JSON: {"opener": "..."}`;
  try {
    const resp = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 200, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const raw = data?.candidates?.[0]?.content?.parts?.map(x => x.text).join('') || '';
    const opener = JSON.parse(raw).opener;
    return validOpener(opener, p) ? opener.trim() : null;
  } catch (e) {
    return null;
  }
}

async function draftInitial(p, settings, fetchImpl = fetch) {
  const opener = await geminiOpener(p, fetchImpl);
  return { ...composeInitial(p, settings, opener), polished: !!opener };
}

module.exports = { shortName, composeInitial, composeFollowup, draftInitial, templateOpener, factSentences, validOpener, greeting, TOOL_NAMES };
