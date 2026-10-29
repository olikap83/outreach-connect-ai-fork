// Fit score, 0–100: how likely this business is to (a) answer and
// (b) be a real partner. Every point comes with a reason a person can
// read on the dashboard, so the score never feels like a black box.
//
// What pushes it up, roughly in order of weight:
//   - we can reach the owner directly (their own email, by name)
//   - close to Storrs (partners get a weekly in-person visit)
//   - an industry where the class has clear, concrete ideas
//   - signs of manual work AI could take over (phone-only booking, quote
//     requests, paper forms, hiring = stretched thin)
//   - signs they're open to new tools (already use online booking,
//     ordering, chat; updated site; active socials)
//   - established (3+ years) but small (a team, not a corporation)

const { BUCKETS } = require('./industries');
const { TOOL_NAMES } = require('./compose');

const cap = str => str.charAt(0).toUpperCase() + str.slice(1);

const BOOKING_HEAVY = new Set(['health', 'booking', 'auto', 'trades']);

function scoreProspect(p) {
  const f = p.facts || {};
  const reasons = [];
  let s = 35;
  // src names the fact a reason rests on, so the desk can link its source.
  const add = (pts, why, src) => {
    s += pts;
    reasons.push({ pts, why, ...(src ? { src } : {}) });
  };

  // Industry
  const b = BUCKETS[p.bucket] || BUCKETS.other;
  if (b.points) add(b.points, `${cap(p.category || 'This industry')}: a type of business with clear, concrete ways AI helps`, 'category');

  // Reachability
  if (!p.email) add(-40, 'No email address found', 'pages');
  else if (p.email_source === 'guess') add(-6, 'Email is a guess from the owner\'s name; check before sending', 'email');
  else {
    const local = p.email.split('@')[0];
    const ownerish = p.contact_name && local.includes(p.contact_name.split(' ')[0].toLowerCase());
    if (ownerish) add(15, `Can email ${p.contact_name} directly`, 'email');
    else if (p.email_confidence === 'high') add(8, 'Found a real inbox on their own site', 'email');
    else add(4, 'Found an email address', 'email');
  }
  if (p.contact_name && !(p.email && p.email.split('@')[0].includes(p.contact_name.split(' ')[0].toLowerCase()))) {
    add(4, `Know who to address: ${p.contact_name}${p.contact_title ? ` (${p.contact_title})` : ''}`, 'contact');
  }

  // Distance from Storrs
  const mi = p.miles_from_storrs != null ? Number(p.miles_from_storrs) : null;
  if (mi != null) {
    if (mi <= 15) add(10, `${Math.round(mi)} miles from Storrs: easy weekly visits`, 'address');
    else if (mi <= 30) add(6, `${Math.round(mi)} miles from Storrs`, 'address');
    else if (mi <= 45) add(0, `${Math.round(mi)} miles from Storrs`, 'address');
    else if (mi <= 70) add(-10, `${Math.round(mi)} miles from Storrs: a long weekly drive`, 'address');
    else add(-25, `${Math.round(mi)} miles from Storrs: too far for weekly visits`, 'address');
  }

  // Manual work AI could take over
  if (f.phone_first) add(6, 'Books or takes orders by phone', 'phone_first');
  if (f.quote_requests) add(5, 'Handles quote / estimate requests', 'quote_requests');
  if (f.paper_forms) add(4, 'Uses paper or PDF forms', 'paper_forms');
  if (f.hiring) add(5, 'Hiring right now (stretched thin)', 'hiring');
  if (BOOKING_HEAVY.has(p.bucket) && f.booking_tools && !f.booking_tools.length && f.pages_read?.length) add(4, 'No online booking found', 'pages');
  if (f.catering) add(3, 'Takes catering / event inquiries', 'catering');

  // Open to new tools
  const modern = [...(f.booking_tools || []), ...(f.chat_tools || []), ...(f.shop_tools || [])];
  const modernKey = ['booking_tools', 'chat_tools', 'shop_tools'].map(k => (f[k] || []).length ? `${k}:${f[k][0]}` : null).find(Boolean);
  if (modern.length) add(4, `Already uses ${modern.slice(0, 2).map(k => TOOL_NAMES[k] || k).join(' and ')}: open to new tools`, modernKey);
  if (f.site_year && f.site_year >= new Date().getUTCFullYear() - 1) add(2, 'Website recently updated', 'site_year');
  else if (f.site_year && f.site_year <= 2019) add(2, `Website last updated around ${f.site_year}`, 'site_year');
  if ((f.socials || []).length >= 2) add(2, 'Active on social media', `socials:${f.socials[0]}`);

  // Established, but small
  const years = f.years_in_business || f.years_claimed || (f.registered_year ? new Date().getUTCFullYear() - f.registered_year : null);
  const yearsKey = f.years_in_business ? 'founded' : f.years_claimed ? 'years_claimed' : 'filing';
  if (years != null) {
    if (years >= 3) add(4, f.founded ? `In business since ${f.founded}` : `${years}+ years in business`, yearsKey);
    else add(-4, 'Newer business (under 3 years)', yearsKey);
  }
  if (f.family_owned) add(3, 'Family-owned', 'family_owned');
  else if (f.locally_owned) add(2, 'Locally owned', 'locally_owned');
  const team = f.team_size_text;
  if (team) {
    if (team >= 5 && team <= 60) add(6, `Team of about ${team}: the size we work with`, 'team_size_text');
    else if (team > 150) add(-20, `Around ${team} employees: likely too big`, 'team_size_text');
  }

  if (!f.pages_read || !f.pages_read.length) {
    if (p.website) add(-6, 'Website didn\'t load', 'website');
    else add(-8, 'No website: less to personalize with', 'search');
  }

  return { fit_score: Math.max(0, Math.min(100, Math.round(s))), fit_reasons: reasons.sort((a, b) => b.pts - a.pts) };
}

module.exports = { scoreProspect };
