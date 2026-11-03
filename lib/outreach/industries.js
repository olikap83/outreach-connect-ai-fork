// What kind of business is this, and what would AI help with there?
//
// OpenStreetMap tags (shop=*, craft=*, office=*, healthcare=*, amenity=*)
// and CT registry NAICS codes both get mapped to a plain-words category
// ("Dentist") and a bucket. The bucket drives two things: how much it
// adds to the fit score, and the "for a business like yours, that usually
// means..." line in the email. The ideas are the same kinds of work the
// class's research calls high-ROI for small businesses (missed calls,
// booking, quote follow-up, answering the same questions).

// Bucket → fit points, the idea line (kept for the dashboard), and what the
// intro email says Soham is interested in about a business like this. It
// finishes "I've always been interested in ...": curiosity, not an
// operations question, which reads like a sales discovery call.
const BUCKETS = {
  trades: {
    points: 12,
    idea: 'For a {cat} business, that usually means texting back missed calls automatically, following up on estimates that went quiet, or spending less time on scheduling and invoices.',
    interest: 'how trades businesses run, since so much of the work happens out on job sites instead of in an office',
  },
  health: {
    points: 12,
    idea: 'For a practice like yours, that usually means fewer phone calls for reminders and rescheduling, faster answers to the questions patients ask every week, or less time on intake paperwork.',
    interest: 'how small practices run as businesses, the side patients never really see',
  },
  professional: {
    points: 10,
    idea: 'For a firm like yours, that usually means less time on client intake, document prep, and answering the same client questions every week.',
    interest: 'how small firms build a client base and keep everything running behind the scenes',
  },
  auto: {
    points: 10,
    idea: 'For a shop like yours, that usually means quicker quotes, automatic updates when a car is ready, and fewer calls asking for a status check.',
    interest: 'how car businesses like yours keep customers coming back year after year',
  },
  manufacturing: {
    points: 10,
    idea: 'For a manufacturer, that usually means less time on quoting and order entry, and less time pulling numbers out of spreadsheets.',
    interest: 'how small manufacturers keep up with orders day to day',
  },
  food: {
    points: 8,
    idea: 'For a {cat}, that usually means answering catering and event inquiries faster, handling the same questions (hours, menu, reservations) automatically, or tightening up ordering and inventory.',
    interest: 'what it actually takes to run a {cat} day to day, beyond what customers see out front',
  },
  booking: {
    points: 8,
    idea: 'For a {cat} business, that usually means fewer no-shows, booking and rescheduling without phone tag, and getting regulars back in the door.',
    interest: 'how {cat} businesses build a loyal group of regulars',
  },
  retail: {
    points: 4,
    idea: 'For a shop like yours, that usually means less time on inventory and reordering, and answering the same customer questions automatically.',
    interest: 'how independent shops decide what to carry and keep people coming back in',
  },
  other: {
    points: 0,
    idea: 'For most businesses your size, that usually means getting a few hours a week back on admin work like scheduling, follow-ups, and answering the same questions.',
    interest: 'how small local businesses actually run, the parts customers never see',
  },
};

// OSM tag value → [category label, bucket]. Anything not listed under
// amenity is ignored (benches, parking, schools, churches...).
const OSM = {
  craft: {
    plumber: ['Plumber', 'trades'], electrician: ['Electrician', 'trades'], hvac: ['HVAC', 'trades'],
    roofer: ['Roofer', 'trades'], carpenter: ['Carpenter', 'trades'], painter: ['Painter', 'trades'],
    builder: ['Builder', 'trades'], gardener: ['Landscaper', 'trades'], landscaper: ['Landscaper', 'trades'],
    stonemason: ['Stonemason', 'trades'], tiler: ['Tile installer', 'trades'], window_construction: ['Window installer', 'trades'],
    floorer: ['Flooring', 'trades'], plasterer: ['Plasterer', 'trades'], locksmith: ['Locksmith', 'trades'],
    brewery: ['brewery', 'food'], winery: ['winery', 'food'], distillery: ['distillery', 'food'], caterer: ['caterer', 'food'],
    bakery: ['bakery', 'food'], confectionery: ['confectionery', 'food'],
    printer: ['Print shop', 'manufacturing'], metal_construction: ['Metal fabrication', 'manufacturing'],
    cabinet_maker: ['Cabinet maker', 'manufacturing'], sawmill: ['Sawmill', 'manufacturing'],
    upholsterer: ['Upholsterer', 'trades'], tailor: ['Tailor', 'retail'], photographer: ['Photographer', 'booking'],
    jeweller: ['Jeweler', 'retail'], shoemaker: ['Shoe repair', 'retail'],
  },
  office: {
    accountant: ['Accounting', 'professional'], tax_advisor: ['Tax prep', 'professional'], lawyer: ['Law', 'professional'],
    insurance: ['Insurance', 'professional'], estate_agent: ['Real estate', 'professional'], financial: ['Financial services', 'professional'],
    financial_advisor: ['Financial advisor', 'professional'], architect: ['Architecture', 'professional'],
    consulting: ['Consulting', 'professional'], engineer: ['Engineering firm', 'professional'], surveyor: ['Surveying', 'professional'],
    it: ['IT services', 'professional'], marketing: ['Marketing', 'professional'], advertising_agency: ['Advertising', 'professional'],
    employment_agency: ['Staffing', 'professional'], property_management: ['Property management', 'professional'],
    construction_company: ['Construction', 'trades'], company: ['Company', 'other'], travel_agent: ['Travel agency', 'booking'],
    veterinary: ['Veterinarian', 'health'], physician: ['Medical practice', 'health'], therapist: ['Therapy practice', 'health'],
    moving_company: ['Moving company', 'trades'], logistics: ['Logistics', 'other'],
  },
  healthcare: {
    dentist: ['Dentist', 'health'], doctor: ['Medical practice', 'health'], clinic: ['Clinic', 'health'],
    physiotherapist: ['Physical therapy', 'health'], chiropractor: ['Chiropractor', 'health'], optometrist: ['Optometrist', 'health'],
    psychotherapist: ['Therapy practice', 'health'], counselling: ['Counseling', 'health'], audiologist: ['Audiologist', 'health'],
    podiatrist: ['Podiatrist', 'health'], speech_therapist: ['Speech therapy', 'health'], occupational_therapist: ['Occupational therapy', 'health'],
    alternative: ['Wellness practice', 'health'], massage: ['Massage therapy', 'booking'], laboratory: ['Lab', 'health'],
  },
  amenity: {
    dentist: ['Dentist', 'health'], doctors: ['Medical practice', 'health'], clinic: ['Clinic', 'health'],
    veterinary: ['Veterinarian', 'health'], restaurant: ['restaurant', 'food'], cafe: ['cafe', 'food'],
    bar: ['bar', 'food'], pub: ['pub', 'food'], ice_cream: ['ice cream shop', 'food'], fast_food: ['restaurant', 'food'],
    car_wash: ['Car wash', 'auto'], car_rental: ['Car rental', 'auto'], driving_school: ['Driving school', 'booking'],
    childcare: ['Childcare', 'booking'], kindergarten: ['Preschool', 'booking'], music_school: ['Music school', 'booking'],
    language_school: ['Language school', 'booking'], dancing_school: ['Dance studio', 'booking'], animal_boarding: ['Pet boarding', 'booking'],
    events_venue: ['Event venue', 'booking'], studio: ['Studio', 'booking'], coworking_space: ['Coworking space', 'booking'],
  },
  leisure: {
    fitness_centre: ['fitness', 'booking'], sports_centre: ['sports center', 'booking'], dance: ['dance studio', 'booking'],
    golf_course: ['golf course', 'booking'], bowling_alley: ['bowling alley', 'booking'], escape_game: ['escape room', 'booking'],
    trampoline_park: ['trampoline park', 'booking'], horse_riding: ['riding stable', 'booking'],
  },
  shop: {
    car_repair: ['Auto repair', 'auto'], tyres: ['Tire shop', 'auto'], car: ['Car dealer', 'auto'], car_parts: ['Auto parts', 'auto'],
    motorcycle: ['Motorcycle shop', 'auto'], boat: ['Boat dealer', 'auto'],
    hairdresser: ['salon', 'booking'], beauty: ['beauty', 'booking'], massage: ['massage', 'booking'], tattoo: ['tattoo', 'booking'],
    cosmetics: ['beauty', 'booking'], nails: ['nail salon', 'booking'], pet_grooming: ['pet grooming', 'booking'],
    bakery: ['bakery', 'food'], butcher: ['butcher shop', 'food'], deli: ['deli', 'food'], farm: ['farm', 'food'],
    confectionery: ['candy shop', 'food'], alcohol: ['liquor store', 'retail'], wine: ['wine shop', 'retail'],
    optician: ['Optician', 'health'], hearing_aids: ['Hearing aids', 'health'], medical_supply: ['Medical supply', 'health'],
    hvac: ['HVAC', 'trades'], doityourself: ['Hardware store', 'retail'], hardware: ['Hardware store', 'retail'],
    trade: ['Trade supplier', 'retail'], florist: ['Florist', 'retail'], garden_centre: ['Garden center', 'retail'],
    furniture: ['Furniture store', 'retail'], jewelry: ['Jeweler', 'retail'], bicycle: ['Bike shop', 'retail'],
    books: ['Bookstore', 'retail'], clothes: ['Clothing store', 'retail'], gift: ['Gift shop', 'retail'], pet: ['Pet store', 'retail'],
    sports: ['Sporting goods', 'retail'], music: ['Music store', 'retail'], musical_instrument: ['Music store', 'retail'],
    appliance: ['Appliance store', 'retail'], electronics: ['Electronics store', 'retail'], computer: ['Computer repair', 'retail'],
    mobile_phone: ['Phone repair', 'retail'], copyshop: ['Print shop', 'retail'], dry_cleaning: ['Dry cleaner', 'retail'],
    laundry: ['Laundromat', 'retail'], funeral_directors: ['Funeral home', 'professional'], travel_agency: ['Travel agency', 'booking'],
    frame: ['Frame shop', 'retail'], craft: ['Craft store', 'retail'], fabric: ['Fabric store', 'retail'], sewing: ['Sewing shop', 'retail'],
    antiques: ['Antique shop', 'retail'], second_hand: ['Consignment shop', 'retail'], kitchen: ['Kitchen design', 'trades'],
    bathroom_furnishing: ['Bath remodeling', 'trades'], flooring: ['Flooring', 'trades'], paint: ['Paint store', 'retail'],
    houseware: ['Home goods', 'retail'], interior_decoration: ['Interior design', 'professional'], storage_rental: ['Self storage', 'other'],
    tobacco: null, vape: null, e_cigarette: null, cannabis: null, lottery: null, pawnbroker: null, weapons: null,
    supermarket: null, convenience: null, department_store: null, variety_store: null, fuel: null, money_lender: null,
  },
};

// Chains and franchises we'd never get anywhere with — the owner isn't
// the one deciding. OSM usually marks these with brand:wikidata, this
// catches the ones that aren't tagged.
const CHAIN_WORDS = [
  'dunkin', 'mcdonald', 'subway', 'starbucks', 'cvs', 'walgreens', 'rite aid', 'stop & shop', 'stop and shop', 'big y',
  'price chopper', 'walmart', 'home depot', 'lowe\'s', 'staples', 'aldi', 'trader joe', 'whole foods', 'shoprite',
  'bank of america', 'td bank', 'webster bank', 'citizens bank', 'wells fargo', 'chase bank', 'santander', 'key bank', 'people\'s united',
  'burger king', 'taco bell', 'domino', 'pizza hut', 'papa john', 'kfc', 'chipotle', 'panera', 'applebee', 'olive garden',
  'ups store', 'fedex', 'usps', 'post office', 'verizon', 'at&t', 't-mobile', 'gamestop', 'advance auto', 'autozone',
  'jiffy lube', 'firestone', 'midas', 'meineke', 'valvoline', 'h&r block', 'jackson hewitt', 'state farm', 'allstate', 'edward jones',
  'great clips', 'supercuts', 'sport clips', 'planet fitness', 'anytime fitness', 'orangetheory', 'petco', 'petsmart', 'tractor supply',
  'dollar general', 'dollar tree', 'family dollar', 'five below', 'marshalls', 'tj maxx', 'kohl\'s', 'best buy', 'sherwin-williams',
  'aspen dental', 'hartford healthcare', 'yale new haven', 'uconn health', 'prohealth', 'starling physicians', 'medexpress', 'goodwill',
  'pizzeria uno', 'uno pizzeria', 'santouka', 'vispring', 'good vibrations', 'sweetgreen', 'shake shack', 'blue bottle',
  'maaco', 'ymca', 'community y',
  'savers', 'aaa', 'samsonite', 'verizon wireless', 'h&r', 'enterprise rent', 'u-haul', 'uhaul', 'coldwell banker', 're/max', 'remax', 'keller williams', 'century 21', 'berkshire hathaway', 'william raveis',
];

// NAICS code prefix → [label, bucket]. Longest prefix wins. null = skip
// (holding companies, landlords, government, churches — the registry is
// full of property-holding LLCs that would otherwise flood the list).
const NAICS = [
  ['5311', null], ['5312', ['Real estate', 'professional']], ['525', null], ['551', null], ['92', null], ['8131', null],
  ['8132', null], ['8133', null], ['8134', null], ['8139', null], ['52211', null], ['52213', null], ['211', null], ['486', null],
  ['238', ['Specialty contractor', 'trades']], ['236', ['Builder', 'trades']], ['237', ['Construction', 'trades']], ['23', ['Construction', 'trades']],
  ['6212', ['Dentist', 'health']], ['6211', ['Medical practice', 'health']], ['6213', ['Therapy practice', 'health']], ['621', ['Healthcare practice', 'health']],
  ['5419', ['Professional services', 'professional']], ['54194', ['Veterinarian', 'health']], ['5411', ['Law', 'professional']],
  ['5412', ['Accounting', 'professional']], ['5413', ['Engineering firm', 'professional']], ['5418', ['Marketing', 'professional']],
  ['541', ['Professional services', 'professional']], ['524', ['Insurance', 'professional']], ['523', ['Financial services', 'professional']],
  ['722', ['restaurant', 'food']], ['3121', ['brewery', 'food']], ['311', ['food producer', 'food']],
  ['8121', ['salon', 'booking']], ['8129', ['personal services', 'booking']], ['7139', ['fitness', 'booking']], ['6244', ['Childcare', 'booking']],
  ['6116', ['school', 'booking']], ['8111', ['Auto repair', 'auto']], ['4411', ['Car dealer', 'auto']], ['811', ['Repair shop', 'trades']],
  ['5617', ['Building services', 'trades']], ['31', ['Manufacturer', 'manufacturing']], ['32', ['Manufacturer', 'manufacturing']],
  ['33', ['Manufacturer', 'manufacturing']], ['44', ['Retail', 'retail']], ['45', ['Retail', 'retail']], ['42', ['Wholesale', 'other']],
  ['484', ['Trucking', 'other']], ['5615', ['Travel agency', 'booking']], ['7211', ['Inn', 'booking']], ['721', ['Lodging', 'booking']],
];

// Institutions, not businesses, whatever else they're tagged with.
const INSTITUTION = {
  amenity: /^(hospital|library|school|college|university|kindergarten_public|townhall|courthouse|police|fire_station|place_of_worship|community_centre|social_facility|prison|post_office|arts_centre|museum)$/,
  healthcare: /^(hospital|blood_donation|centre)$/,
  office: /^(government|educational_institution|university|association|ngo|religion|political_party|diplomatic|charity|foundation|union|research)$/,
};
function classifyOsm(tags) {
  for (const [key, re] of Object.entries(INSTITUTION)) if (tags[key] && re.test(tags[key])) return null;
  // A college's or the government's own website: a department, not a business.
  const site = [tags.website, tags['contact:website'], tags.email, tags['contact:email']].filter(Boolean).join(' ');
  if (/\.(edu|gov|mil)(\/|\s|$)|@[a-z0-9.-]+\.(edu|gov)\b/i.test(site)) return null;
  if (tags.government || tags.operator_type === 'government' || /\b(university|college|hospital|library|school district)\b/i.test(tags.name || '')) return null;
  for (const key of ['craft', 'healthcare', 'office', 'shop', 'amenity', 'leisure']) {
    const val = tags[key];
    if (!val) continue;
    const table = OSM[key];
    // "office=yes" / "healthcare=yes" say nothing about what they do.
    if (val === 'yes') {
      if (key === 'office') return { category: 'Office', bucket: 'professional' };
      if (key === 'healthcare') return { category: 'Healthcare practice', bucket: 'health' };
      continue;
    }
    if (!(val in table)) {
      // Unlisted shop/craft/office values are still real businesses;
      // unlisted amenity/leisure values usually aren't (benches, parks).
      if (key === 'shop') return { category: humanize(val), bucket: 'retail' };
      if (key === 'craft') return { category: humanize(val), bucket: 'trades' };
      if (key === 'office') return { category: humanize(val), bucket: 'professional' };
      if (key === 'healthcare') return { category: humanize(val), bucket: 'health' };
      continue;
    }
    const hit = table[val];
    if (hit === null) return null; // explicitly skipped
    return { category: hit[0], bucket: hit[1] };
  }
  return null;
}

// CT's registry stores NAICS as one text field like
// "Offices of Dentists (621210)" — pull the digits out.
function classifyNaics(naicsText) {
  const m = String(naicsText || '').match(/(\d{2,6})/);
  if (!m) return { category: null, bucket: 'other', code: null };
  const code = m[1];
  let best = null;
  for (const [prefix, hit] of NAICS) {
    if (code.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, hit];
  }
  if (!best) return { category: null, bucket: 'other', code };
  if (best[1] === null) return null;
  return { category: best[1][0], bucket: best[1][1], code };
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const CHAIN_RE = new RegExp(`(^|[^a-z])(${CHAIN_WORDS.map(escapeRe).join('|')})([^a-z]|$)`, 'i');

function isChain(name, tags = {}) {
  if (tags['brand:wikidata'] || tags['brand:wikipedia']) return true;
  return CHAIN_RE.test(String(name || '').replace(/[’]/g, "'"));
}

function humanize(v) {
  const s = String(v).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { BUCKETS, OSM, NAICS, classifyOsm, classifyNaics, isChain };
