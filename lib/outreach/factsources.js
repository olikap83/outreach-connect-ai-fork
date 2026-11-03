// The link behind every fact we show or post about a business. Each key
// names a kind of fact; sourceUrl returns where it can be checked, or null
// when we have nothing to point to (and then the fact isn't shown).
//
// The desk (artifact/outreach-desk.html) has a copy of this; keep them in step.

const CT_DATA = 'https://data.ct.gov/resource';

// Some state-filing businesses carry their CT business id in source_ref
// instead of registry_id; that's a filing, not a map entry.
const OSM_REF = /^(node|way|relation)\/\d+$/;
const filingId = p => p.registry_id || (p.source_ref && !OSM_REF.test(p.source_ref) ? p.source_ref : null);
function filingUrl(p) {
  const id = filingId(p);
  return id ? `${CT_DATA}/n7gp-d28j.json?id=${encodeURIComponent(id)}` : null;
}
function peopleOnFilingUrl(p, businessId) {
  const id = businessId || filingId(p);
  return id ? `${CT_DATA}/ka36-64k6.json?business_id=${encodeURIComponent(id)}` : null;
}
function osmUrl(p) {
  return p.source_ref && OSM_REF.test(p.source_ref) ? `https://www.openstreetmap.org/${p.source_ref}` : null;
}
function websiteUrl(p) {
  if (p.website) return /^https?:/i.test(p.website) ? p.website : `https://${p.website}`;
  return null;
}
// Where the business's listing came from: its map entry or its CT filing.
function listingUrl(p) {
  return p.source === 'osm' ? osmUrl(p) || filingUrl(p) : filingUrl(p) || osmUrl(p);
}

const nameWords = n => String(n || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !/^(dr|mr|mrs|ms|jr|sr)$/.test(w));
function samePerson(a, b) {
  const A = nameWords(a), B = nameWords(b);
  return !!(A.length && B.length && A[0] === B[0] && A[A.length - 1] === B[B.length - 1]);
}
function personUrl(p, name) {
  const people = ((p.facts || {}).people || []).filter(x => samePerson(x.name, name));
  const site = people.find(x => x.url);
  if (site) return site.url;
  const filed = people.find(x => x.how === 'state filing' && (x.business_id || p.registry_id));
  return filed ? peopleOnFilingUrl(p, filed.business_id) : null;
}

// Whether the email address itself points at this person: juliegauthiernyc@
// for Julie Gauthier, jcarter@ for Jordan Carter, katie@ for Katie Wilcock.
function emailMatchesName(email, name) {
  const local = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  const parts = nameWords(name);
  if (!local || parts.length < 2) return false;
  const first = parts[0], last = parts[parts.length - 1];
  return local.includes(last) || local === first || local.startsWith(first[0] + last.slice(0, 4)) || (first.length >= 4 && local.startsWith(first));
}

// Is this name confirmed as someone who reads this email? Returns how and a
// link, or null. A name that isn't confirmed is never used in a greeting.
//  - named on their own website
//  - on the state filing, and the email address is clearly theirs
//  - on the state filing, which lists this same email, with at most one
//    other person on it (a small LLC's owners read the address they filed)
// barry@ when the name is Steve Smith: the inbox is someone else's. Short,
// person-like addresses that don't match the name, the business name or its
// initials count as someone else's; info@, office@ and long business-name
// addresses (atozmarketplace@) don't.
const ROLE_LOCAL = /^(info|office|contact|hello|hi|admin|sales|support|team|shop|store|mail|email|inquiries|inquiry|booking|bookings|appointments|service|frontdesk|reception|orders|help|marketing|general|main|business|manager|owner|accounts|billing|jobs|careers)$/;
function addressIsSomeoneElse(email, name, businessName) {
  const local = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!local || local.length < 3 || local.length > 8 || ROLE_LOCAL.test(local)) return false;
  if (emailMatchesName(email, name)) return false;
  const words = nameWords(businessName);
  if (words.some(w => w.length >= 3 && (local.includes(w) || w.includes(local)))) return false;
  const initials = String(businessName || '').toLowerCase().split(/[^a-z]+/).filter(Boolean).map(w => w[0]).join('');
  if (initials.length >= 2 && local.startsWith(initials.slice(0, 2))) return false;
  const first = nameWords(name)[0] || '';
  if (first && (local.startsWith(first.slice(0, 3)) || first.startsWith(local.slice(0, 3)))) return false;
  return true;
}

function confirmName(p, name) {
  if (!name) return null;
  if (addressIsSomeoneElse(p.email, name, p.name)) return null;
  const people = ((p.facts || {}).people || []).filter(x => samePerson(x.name, name));
  const site = people.find(x => x.url || x.doctor_url);
  if (site) return { how: 'named on their website', url: site.url || site.doctor_url };
  const filed = people.find(x => x.how === 'state filing' && (x.business_id || p.registry_id));
  // "Ralph J Laguardia M.D.": the business is named after them.
  const last = nameWords(name).slice(-1)[0];
  if (filed && last && last.length >= 4 && nameWords(p.name).includes(last)) return { how: 'the business is named after them, and they are on its state filing', url: peopleOnFilingUrl(p, filed.business_id) };
  if (!filed) return emailMatchesName(p.email, name) && p.website ? { how: 'matches their email address', url: websiteUrl(p) } : null;
  const url = peopleOnFilingUrl(p, filed.business_id);
  if (emailMatchesName(p.email, name)) return { how: 'on the state filing, and the email address is theirs', url };
  const onFiling = new Set(((p.facts || {}).people || []).filter(x => x.how === 'state filing').map(x => nameWords(x.name).join(' '))).size;
  if (p.email_source === 'registry' && onFiling <= 2) {
    return { how: onFiling === 1 ? 'the only person on the state filing, which also lists this email' : 'one of the two people on the state filing, which also lists this email', url };
  }
  return null;
}

function emailUrl(p) {
  if (!p.email) return null;
  if (p.email_url) return p.email_url;
  if (p.email_source === 'registry') return filingUrl(p);
  if (p.email_source === 'osm') return osmUrl(p);
  return null;
}

function sourceUrl(p, key) {
  const f = p.facts || {};
  switch (key) {
    case 'category': return f.naics ? filingUrl(p) || listingUrl(p) : listingUrl(p);
    case 'address': return listingUrl(p);
    case 'filing': return filingUrl(p);
    case 'people_on_filing': return peopleOnFilingUrl(p);
    case 'email': return emailUrl(p);
    case 'contact': return p.contact_name ? personUrl(p, p.contact_name) : null;
    case 'phone': return p.phone ? p.phone_url || null : null;
    case 'website': case 'pages': return websiteUrl(p);
    case 'search': return `https://www.google.com/search?q=${encodeURIComponent(`${p.name} ${p.town || ''} ${p.state || ''}`.trim())}`;
    case 'registered_year': case 'naics': case 'business_type': return filingUrl(p);
    default: return (f.sources || {})[key] || null;
  }
}

module.exports = { confirmName, addressIsSomeoneElse, emailMatchesName, sourceUrl, filingUrl, peopleOnFilingUrl, osmUrl, listingUrl, personUrl, emailUrl, samePerson };
