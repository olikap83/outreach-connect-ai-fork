// The link behind every fact we show or post about a business. Each key
// names a kind of fact; sourceUrl returns where it can be checked, or null
// when we have nothing to point to (and then the fact isn't shown).
//
// The desk (artifact/outreach-desk.html) has a copy of this; keep them in step.

const CT_DATA = 'https://data.ct.gov/resource';

function filingUrl(p) {
  return p.registry_id ? `${CT_DATA}/n7gp-d28j.json?id=${encodeURIComponent(p.registry_id)}` : null;
}
function peopleOnFilingUrl(p, businessId) {
  const id = businessId || p.registry_id;
  return id ? `${CT_DATA}/ka36-64k6.json?business_id=${encodeURIComponent(id)}` : null;
}
function osmUrl(p) {
  return p.source_ref ? `https://www.openstreetmap.org/${p.source_ref}` : null;
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

module.exports = { sourceUrl, filingUrl, peopleOnFilingUrl, osmUrl, listingUrl, personUrl, emailUrl, samePerson };
