// Run with: npm test
// Everything external (websites, the CT registry, Overpass, Gmail, the
// CRM) is faked, so these run offline and never send a real email.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { nameKey, businessDaysSince, nyStartOfDay, milesFromStorrs } = require('../lib/outreach/util');
const { osmToProspect, tidyPersonName, prettyBusinessName, pickColumn, _resetColumnCache } = require('../lib/outreach/sources');
const { extractPage, rankEmails, enrichProspect, siteMatchesBusiness, cleanEmail } = require('../lib/outreach/enrich');
const { scoreProspect } = require('../lib/outreach/score');
const { composeInitial, composeFollowup, validOpener } = require('../lib/outreach/compose');
const { classifyIncoming, freshText } = require('../lib/outreach/mailer');
const { readRpc } = require('../lib/outreach/crm');
const { MemoryStore } = require('../lib/outreach/store');
const engine = require('../lib/outreach/engine');
const { mergeSettings } = require('../lib/outreach/settings');

const fx = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function cfEncode(email, key = 0x42) {
  return key.toString(16).padStart(2, '0') + [...email].map(c => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
}

const SITE = {
  'https://willowcreekdental.com/': fx('dental-home.html'),
  'https://willowcreekdental.com/about-us': fx('dental-about.html'),
  'https://willowcreekdental.com/contact': fx('dental-contact.html').replace('ENCODED', cfEncode('frontdesk@willowcreekdental.com')),
  'https://hartwellcpa.com/': fx('accountant-site.html'),
};

function fakeResponse(body, { status = 200, type = 'text/html', url } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: k => (k.toLowerCase() === 'content-type' ? type : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

// Fake web: the fixture sites plus a tiny CT registry (Socrata) that has
// no match for anything, so enrichment relies on the website.
function fakeFetch(registryRows = []) {
  return async (url) => {
    const u = String(url);
    if (SITE[u]) return fakeResponse(SITE[u], { url: u });
    if (u.includes('/api/views/n7gp-d28j.json')) {
      return fakeResponse({ columns: [
        { fieldName: 'id', name: 'Id' }, { fieldName: 'name', name: 'Name' }, { fieldName: 'status', name: 'Status' },
        { fieldName: 'business_email_address', name: 'Business Email Address' }, { fieldName: 'naics_code', name: 'NAICS Code' },
        { fieldName: 'billingcity', name: 'Billing City' }, { fieldName: 'date_registration', name: 'Date Registration' },
      ] }, { type: 'application/json' });
    }
    if (u.includes('/api/views/ka36-64k6.json')) {
      return fakeResponse({ columns: [{ fieldName: 'business_key', name: 'Business Key' }, { fieldName: 'name__c', name: 'Name' }, { fieldName: 'designation', name: 'Designation' }] }, { type: 'application/json' });
    }
    if (u.includes('/resource/n7gp-d28j.json')) return fakeResponse(registryRows, { type: 'application/json' });
    if (u.includes('/resource/ka36-64k6.json')) return fakeResponse([{ business_key: '001', name__c: 'WHITFIELD, KAREN A', designation: 'Member' }], { type: 'application/json' });
    return fakeResponse('not found', { status: 404 });
  };
}

const okResolver = { resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }] };

// ---------- helpers ----------

test('nameKey matches the CRM seed keys', () => {
  assert.equal(nameKey('The Gold Trader, LLC'), 'gold trader');
  assert.equal(nameKey("Munson's Chocolates"), 'munsons chocolates');
  assert.equal(nameKey('K.L. Smith Agency LLC'), 'k l smith agency');
  assert.equal(nameKey('Clancy’s HIIT & Fit'), 'clancys hiit fit');
  assert.equal(nameKey('United Gear & Machine Co.'), 'united gear machine');
  assert.equal(nameKey('Dri-Air Industries'), 'dri air industries');
  // and the migration's seed rows use exactly these keys
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '007_outreach.sql'), 'utf8');
  for (const m of sql.matchAll(/\('([a-z0-9 ]+)', '((?:[^']|'')+)', 'In class CRM'\)/g)) {
    assert.equal(nameKey(m[2].replace(/''/g, "'")), m[1], `seed key for ${m[2]}`);
  }
});

test('business days and New York day boundaries', () => {
  // Fri → next Wed = 3 business days (Mon, Tue, Wed)
  assert.equal(businessDaysSince('2026-10-23T15:00:00Z', new Date('2026-10-28T15:00:00Z')), 3);
  // 1am UTC on Oct 29 is still Oct 28 in New York
  const start = nyStartOfDay(new Date('2026-10-29T01:00:00Z'));
  assert.equal(start.toISOString(), '2026-10-28T04:00:00.000Z');
  assert.ok(Math.abs(milesFromStorrs(41.7658, -72.6734) - 22) < 2, 'Hartford is ~22 miles from Storrs');
});

// ---------- sourcing ----------

test('OSM elements become prospects; chains and junk are dropped', () => {
  const good = osmToProspect({ type: 'node', id: 1, lat: 41.80, lon: -72.25, tags: { name: 'Willow Creek Family Dentistry', amenity: 'dentist', website: 'willowcreekdental.com', 'addr:street': 'Storrs Rd', 'addr:housenumber': '12' } }, 'Mansfield');
  assert.equal(good.category, 'Dentist');
  assert.equal(good.bucket, 'health');
  assert.equal(good.website, 'https://willowcreekdental.com/');
  assert.equal(good.domain, 'willowcreekdental.com');
  assert.equal(good.address, '12 Storrs Rd, Mansfield');
  assert.ok(good.miles_from_storrs < 1);

  assert.equal(osmToProspect({ type: 'node', id: 2, tags: { name: "Dunkin'", amenity: 'cafe', website: 'dunkin.com' } }, 'Mansfield'), null);
  assert.equal(osmToProspect({ type: 'node', id: 3, tags: { name: 'Some Cafe', amenity: 'cafe', website: 'x.com', 'brand:wikidata': 'Q1' } }, 'Mansfield'), null);
  assert.equal(osmToProspect({ type: 'node', id: 4, tags: { name: 'Town Bench', amenity: 'bench' } }, 'Mansfield'), null);
  assert.equal(osmToProspect({ type: 'node', id: 5, tags: { name: 'No Web Plumbing', craft: 'plumber' } }, 'Mansfield'), null, 'nothing to email and nowhere to look');
  const withEmail = osmToProspect({ type: 'way', id: 6, center: { lat: 41.7, lon: -72.3 }, tags: { name: 'Ace Plumbing', craft: 'plumber', email: 'Ace@AcePlumbingCT.com' } }, 'Coventry');
  assert.equal(withEmail.email, 'ace@aceplumbingct.com');
  assert.equal(withEmail.lat, 41.7);
});

test('registry helpers: names, columns', () => {
  assert.equal(tidyPersonName('WHITFIELD, KAREN A'), 'Karen Whitfield');
  assert.equal(tidyPersonName('JOHN MCDONALD'), 'John McDonald');
  assert.equal(tidyPersonName('ACME HOLDINGS LLC'), null);
  assert.equal(prettyBusinessName('WILLOW CREEK FAMILY DENTISTRY LLC'), 'Willow Creek Family Dentistry LLC');
  const cols = [{ field: 'id', name: 'Id' }, { field: 'name', name: 'Name' }, { field: 'name_of_agent', name: 'Agent Name' }, { field: 'billingcity', name: 'City' }];
  assert.equal(pickColumn(cols, [/^name$/i, /name/i], /agent/i), 'name');
  assert.equal(pickColumn(cols, [/city/i]), 'billingcity');
});

// ---------- enrichment ----------

test('email extraction: mailto, [at]/[dot], Cloudflare, and junk filtering', () => {
  const page = extractPage(SITE['https://willowcreekdental.com/contact'], 'https://willowcreekdental.com/contact');
  assert.ok(page.emails.includes('office@willowcreekdental.com'));
  assert.ok(page.emails.includes('karen@willowcreekdental.com'), 'deobfuscated [at]/[dot]');
  assert.ok(page.emails.includes('frontdesk@willowcreekdental.com'), 'decoded Cloudflare email');
  assert.ok(!page.emails.some(e => e.startsWith('noreply')));
  assert.equal(cleanEmail('logo@2x.png'), null);
  assert.equal(cleanEmail('mailto:Hello@Shop.com?subject=hi'), 'hello@shop.com');
});

test('email ranking prefers the owner, then the office, never the web designer', () => {
  const ranked = rankEmails(['hello@pixelbarn.design', 'office@willowcreekdental.com', 'karen@willowcreekdental.com', 'careers@willowcreekdental.com'], {
    domain: 'willowcreekdental.com',
    people: [{ name: 'Karen Whitfield', role: 'owner' }],
  });
  assert.deepEqual(ranked.map(r => r.email), ['karen@willowcreekdental.com', 'office@willowcreekdental.com', 'careers@willowcreekdental.com', 'hello@pixelbarn.design']);
  assert.ok(ranked[3].score < 30);
});

test('enrichProspect reads the whole site and finds the owner, email and facts', async () => {
  _resetColumnCache();
  const p = { name: 'Willow Creek Family Dentistry', name_key: 'willow creek family dentistry', bucket: 'health', category: 'Dentist', website: 'https://willowcreekdental.com/', domain: 'willowcreekdental.com', town: 'Mansfield', source: 'osm', facts: {} };
  const patch = await enrichProspect(p, { fetchImpl: fakeFetch([]), resolver: okResolver });
  assert.equal(patch.email, 'karen@willowcreekdental.com');
  assert.equal(patch.email_confidence, 'high');
  assert.equal(patch.contact_name, 'Karen Whitfield');
  assert.match(patch.contact_title, /Owner|DMD/);
  const f = patch.facts;
  assert.equal(f.founded, 1998);
  assert.equal(f.family_owned, true);
  assert.equal(f.phone_first, true);
  assert.equal(f.paper_forms, true);
  assert.equal(f.hiring, true);
  assert.equal(f.team_size_text, 9);
  assert.equal(f.site_year, 2019);
  assert.equal(f.platform, 'wix');
  assert.deepEqual(f.socials.sort(), ['facebook', 'instagram']);
  assert.equal(f.pages_read.length, 3);
});

test('a registry email on someone else\'s domain (their accountant) is thrown out', async () => {
  _resetColumnCache();
  const p = { name: 'Maple Ridge Landscaping', name_key: 'maple ridge landscaping', bucket: 'trades', website: 'https://hartwellcpa.com/', domain: 'hartwellcpa.com', town: 'Tolland', source: 'registry', email: 'info@hartwellcpa.com', email_source: 'registry', registry: { id: '9', email: 'info@hartwellcpa.com', principals: [] }, facts: {} };
  const pages = [extractPage(SITE['https://hartwellcpa.com/'], 'https://hartwellcpa.com/')];
  assert.equal(siteMatchesBusiness(pages, p.name), false);
  const patch = await enrichProspect(p, { fetchImpl: fakeFetch([]), resolver: okResolver });
  assert.equal(patch.website, null);
  assert.equal(patch.email, null);
  assert.ok(patch.facts.enrich_notes.some(n => /different business/.test(n)));
});

// ---------- scoring ----------

test('fit score rewards reachable, nearby, manual-heavy small businesses', () => {
  const strong = scoreProspect({ bucket: 'health', category: 'Dentist', email: 'karen@willowcreekdental.com', email_confidence: 'high', email_source: 'website', contact_name: 'Karen Whitfield', miles_from_storrs: 3,
    facts: { pages_read: ['x'], phone_first: true, paper_forms: true, hiring: true, booking_tools: [], founded: 1998, years_in_business: 28, family_owned: true, team_size_text: 9, socials: ['facebook', 'instagram'] } });
  const weak = scoreProspect({ bucket: 'retail', category: 'Gift shop', email: 'x@gmail.com', email_confidence: 'medium', email_source: 'registry', miles_from_storrs: 80, facts: {} });
  const none = scoreProspect({ bucket: 'trades', email: null, miles_from_storrs: 10, facts: { pages_read: ['x'] } });
  assert.ok(strong.fit_score >= 85, `strong ${strong.fit_score}`);
  assert.ok(weak.fit_score <= 25, `weak ${weak.fit_score}`);
  assert.ok(none.fit_score < 30, `no email ${none.fit_score}`);
  assert.ok(strong.fit_reasons.some(r => /Karen Whitfield/.test(r.why)));
  assert.ok(weak.fit_reasons.some(r => /too far/.test(r.why)));
});

// ---------- composing ----------

const settings = mergeSettings({});
const dentist = { id: 'abc', name: 'Willow Creek Family Dentistry', town: 'Mansfield', bucket: 'health', category: 'Dentist', contact_name: 'Karen Whitfield', contact_title: 'Owner', email: 'karen@willowcreekdental.com', miles_from_storrs: 3,
  facts: { founded: 1998, family_owned: true, phone_first: true, booking_tools: [] } };

test('initial email is personal, honest, short, and has an easy no', () => {
  const { subject, body } = composeInitial(dentist, settings);
  assert.ok(subject.length < 60);
  assert.match(body, /^Hi Karen,/);
  assert.match(body, /Willow Creek Family Dentistry/);
  assert.match(body, /since 1998|family-owned/);
  assert.match(body, /Connect\.AI/);
  assert.doesNotMatch(body, /connect-ai\.world\/apply|free AI-readiness|build it for free/);
  assert.doesNotMatch(body, /Small Business Development Center/);
  assert.match(body, /accounting major/);
  assert.doesNotMatch(body.split('Thanks,')[0], /https?:|linkedin/i);
  assert.match(body, /soham\.shah@uconn\.edu · linkedin\.com\/in\/soham-shah-uconn$/);
  assert.match(body, /Henkel/);
  assert.match(body, /Andersen/);
  assert.match(body, /start my own/);
  assert.match(body, /15-minute call/);
  assert.match(body, /stop by since I'm in Storrs/);
  assert.match(body, /no worries at all/);
  assert.match(subject, /UConn/);
  assert.match(subject, /Willow Creek Family Dentistry/);
  assert.match(body, /I'm curious how a practice your size/);
  assert.doesNotMatch(body, /\{|\}|undefined|null/);
  const words = body.split(/\s+/).length;
  assert.ok(words < 190, `email is ${words} words`);
});

test('wording varies between businesses', () => {
  const variants = new Set();
  for (let i = 0; i < 12; i++) variants.add(composeInitial({ ...dentist, id: `id-${i}`, name: `Biz ${i}` }, settings).body.split('\n\n')[1].replace(/Biz \d+/, 'X'));
  assert.ok(variants.size >= 3, `only ${variants.size} opener variants`);
});

test('no name found → "Hi there"; far away → no offer to drop by', () => {
  const { body } = composeInitial({ ...dentist, contact_name: null, miles_from_storrs: 60, facts: {} }, settings);
  assert.match(body, /^Hi there,/);
  assert.doesNotMatch(body, /in person/);
});

test('follow-up threads under the first subject', () => {
  const fu = composeFollowup(dentist, settings, 'A question for Willow Creek Family Dentistry');
  assert.equal(fu.subject, 'Re: A question for Willow Creek Family Dentistry');
  assert.match(fu.body, /bumping/);
  assert.match(fu.body, /call/);
});

test('Gemini output is rejected if it invents numbers or sounds like marketing', () => {
  assert.equal(validOpener('I came across Willow Creek while looking at Mansfield dentists, and saw you have been around since 1998.', dentist), true);
  assert.equal(validOpener('I came across Willow Creek and saw you have served 5,000 patients.', dentist), false);
  assert.equal(validOpener('Willow Creek could unlock huge growth with AI!', dentist), false);
});

// ---------- inbox classification ----------

test('incoming mail is sorted into reply / no thanks / auto-reply / bounce', () => {
  const h = {};
  assert.equal(classifyIncoming({ fromAddress: 'karen@x.com', subject: 'Re: hi', headers: h, text: 'Sure, call me Tuesday.\n\nOn Mon, Oct 26, 2026 at 9:00 AM Soham wrote:\n> no thanks' }), 'reply');
  assert.equal(classifyIncoming({ fromAddress: 'karen@x.com', subject: 'Re: hi', headers: h, text: 'No thanks, we are all set.' }), 'not_interested');
  assert.equal(classifyIncoming({ fromAddress: 'karen@x.com', subject: 'Automatic reply: hi', headers: h, text: 'I am away' }), 'auto_reply');
  assert.equal(classifyIncoming({ fromAddress: 'karen@x.com', subject: 'hi', headers: { 'auto-submitted': 'auto-replied' }, text: 'away' }), 'auto_reply');
  assert.equal(classifyIncoming({ fromAddress: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', headers: h, text: '' }), 'bounce');
  assert.equal(freshText('Sounds good!\n\nOn Tue, Oct 27, 2026, Soham wrote:\n> quoted'), 'Sounds good!');
});

test('CRM client reads JSON and SSE responses', async () => {
  const sse = { headers: { get: () => 'text/event-stream' }, text: async () => 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n' };
  assert.deepEqual((await readRpc(sse)).result, { ok: true });
  const json = { headers: { get: () => 'application/json' }, text: async () => '{"jsonrpc":"2.0","id":1,"result":{"x":2}}' };
  assert.deepEqual((await readRpc(json)).result, { x: 2 });
});

// ---------- the whole loop ----------

function fakeMailer() {
  const sent = [];
  let inbox = [];
  return {
    sent,
    setInbox: items => { inbox = items; },
    mailConfig: () => ({ configured: true, user: 'soham@example.com' }),
    sendMail: async m => { sent.push(m); return { messageId: `<m${sent.length}@example.com>` }; },
    checkInbox: async () => inbox,
  };
}

const noCrm = { crmConfig: () => ({ configured: false }) };

test('end to end: source → enrich → draft → approve → send → follow up → reply', async () => {
  _resetColumnCache();
  const store = new MemoryStore();
  await store.upsertTown({ town: 'Mansfield', enabled: true });
  await store.upsertExcluded([{ name_key: 'mansfield family dental', name: 'Mansfield Family Dental', reason: 'In class CRM' }]);
  const mailer = fakeMailer();
  let clock = new Date('2026-10-27T14:00:00Z'); // Tue 10am New York
  const deps = {
    fetchImpl: fakeFetch([]),
    resolver: okResolver,
    now: () => clock,
    sleep: async () => {},
    mailer,
    crm: noCrm,
    sourceOsm: async town => [
      osmToProspect({ type: 'node', id: 1, lat: 41.80, lon: -72.25, tags: { name: 'Willow Creek Family Dentistry', amenity: 'dentist', website: 'https://willowcreekdental.com/' } }, town),
      osmToProspect({ type: 'node', id: 2, lat: 41.80, lon: -72.25, tags: { name: 'Mansfield Family Dental', amenity: 'dentist', website: 'https://mfd.example/' } }, town),
    ],
    sourceRegistry: async () => [],
    draft: async (p, s) => composeInitial(p, s),
  };

  // 1. a tick finds, researches and drafts — but sends nothing (nothing approved)
  let report = await engine.tick(store, deps);
  assert.equal(report.source.added, 1, 'excluded CRM business is skipped');
  assert.equal(report.enrich.enriched, 1);
  assert.equal(mailer.sent.length, 0);
  const [p] = await store.listProspects({ statuses: ['ready'] });
  assert.equal(p.email, 'karen@willowcreekdental.com');
  assert.ok(p.fit_score >= 80);
  const draft = (await store.listMessages(p.id))[0];
  assert.equal(draft.status, 'draft');
  assert.match(draft.body, /^Hi (Karen|Dr\. Whitfield),/);

  // 2. approve → next tick sends it
  assert.equal(await store.claim(p.id, 'ready', 'queued'), true);
  report = await engine.tick(store, deps);
  assert.equal(report.send.sent, 1);
  assert.equal(mailer.sent[0].to, 'karen@willowcreekdental.com');
  assert.equal((await store.getProspect(p.id)).status, 'sent');

  // outside sending hours: nothing goes out
  clock = new Date('2026-10-28T02:00:00Z'); // 10pm New York
  report = await engine.tick(store, deps);
  assert.equal(report.send.skipped, 'Outside sending hours');

  // 3. four business days later with no reply → one follow-up, threaded
  clock = new Date('2026-11-02T15:00:00Z'); // Mon
  report = await engine.tick(store, deps);
  assert.equal(report.send.results[0].kind, 'followup');
  assert.equal(mailer.sent[1].inReplyTo, '<m1@example.com>');
  assert.match(mailer.sent[1].subject, /^Re: /);
  assert.equal((await store.getProspect(p.id)).status, 'followed_up');

  // ...and never a second follow-up
  clock = new Date('2026-11-10T15:00:00Z');
  await engine.tick(store, deps);
  assert.equal(mailer.sent.length, 2);

  // 4. they reply → marked replied, reply saved, shows in activity
  mailer.setInbox([{ prospectId: p.id, kind: 'reply', messageId: '<r1@x.com>', fromAddress: 'karen@willowcreekdental.com', subject: 'Re: ...', snippet: 'Sure, happy to chat. Thursday?', date: clock.toISOString() }]);
  report = await engine.tick(store, deps);
  assert.equal(report.inbox.new, 1);
  const after = await store.getProspect(p.id);
  assert.equal(after.status, 'replied');
  const msgs = await store.listMessages(p.id);
  assert.equal(msgs.filter(m => m.direction === 'in').length, 1);
  assert.ok((await store.listEvents()).some(e => e.kind === 'replied' && /happy to chat/.test(e.body)));

  // the same reply seen again isn't double-counted
  report = await engine.tick(store, deps);
  assert.equal(report.inbox.new, 0);
});

test('daily cap, auto-queue rules, and overlapping runs never double-send', async () => {
  const store = new MemoryStore();
  await store.saveSettings({ daily_cap: 2, per_tick: 5, auto_queue: true, auto_queue_min_fit: 60 });
  const mailer = fakeMailer();
  const clock = new Date('2026-10-27T14:00:00Z');
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const [row] = await store.insertProspects([{ name: `Biz ${i}`, name_key: `biz ${i}`, town: 'Mansfield', email: `owner${i}@biz${i}.com`, status: 'queued', fit_score: 70 + i, source: 'osm' }]);
    await store.updateProspect(row.id, { status: 'queued' });
    await store.insertMessage({ prospect_id: row.id, kind: 'initial', direction: 'out', status: 'draft', subject: 's', body: 'b' });
    ids.push(row.id);
  }
  const deps = { ...engine.defaultDeps(), now: () => clock, sleep: async () => {}, mailer, crm: noCrm };
  const s = await store.getSettings();
  const [a, b] = await Promise.all([engine.sendStep(store, s, deps), engine.sendStep(store, s, deps)]);
  assert.ok(mailer.sent.length <= 3, `sent ${mailer.sent.length} with a cap of 2`);
  assert.equal(new Set(mailer.sent.map(m => m.to)).size, mailer.sent.length, 'no address emailed twice');
  // highest fit goes first
  assert.equal(mailer.sent[0].to, 'owner3@biz3.com');
  const c = await engine.sendStep(store, s, deps);
  assert.match(c.skipped, /Daily cap/);

  // auto-queue: a guessed address is never auto-queued
  const store2 = new MemoryStore();
  await store2.saveSettings({ auto_queue: true, auto_queue_min_fit: 10 });
  const [g] = await store2.insertProspects([{ name: 'Guess Co', name_key: 'guess co', town: 'Mansfield', source: 'osm', bucket: 'trades' }]);
  await engine.enrichStep(store2, await store2.getSettings(), {
    ...deps,
    enrich: async () => ({ email: 'bob@guessco.com', email_source: 'guess', email_confidence: 'low', facts: { pages_read: ['x'] } }),
    draft: async (p, st) => composeInitial(p, st),
  }, { ids: [g.id] });
  assert.equal((await store2.getProspect(g.id)).status, 'ready');
});

// ---------- CRM notes ----------

const { buildCrmNotes, hasSubstance } = require('../lib/outreach/crmnotes');

test('CRM notes say something real about the business', () => {
  const notes = buildCrmNotes({
    name: 'Willow Creek Family Dentistry, LLC', town: 'Mansfield', address: '12 Storrs Rd, Mansfield', miles_from_storrs: 2.1,
    website: 'https://willowcreekdental.com/', contact_name: 'Karen Whitfield', contact_title: 'Owner',
    email: 'karen@willowcreekdental.com', email_source: 'website', phone: '(860) 555-0142', fit_score: 88, category: 'Dentist',
    facts: { about: 'We are a family-owned practice serving Mansfield since 1998.', team_size_text: 9, founded: 1998, phone_first: true, family_owned: true },
  });
  assert.match(notes, /What they do: We are a family-owned practice/);
  assert.match(notes, /Size: About 9 people/);
  assert.match(notes, /In business since: 1998/);
  assert.match(notes, /Website: https:\/\/willowcreekdental\.com\//);
  assert.match(notes, /Contact: Karen Whitfield \(Owner\), karen@willowcreekdental\.com \(from their website\)/);
  assert.match(notes, /books appointments\/orders by phone/);
  assert.doesNotMatch(notes, /undefined|null/);

  const reg = buildCrmNotes({ name: 'Rusty Mowers LLC', town: 'Mansfield', contact_name: 'Yasmine DelRio', email: 'rustymowersllc@gmail.com', email_source: 'registry',
    facts: { naics: 'Landscaping Services (561730)', registered_year: 2019, people: [{ name: 'Yasmine DelRio', how: 'state filing' }] } });
  assert.match(reg, /What they do: Landscaping Services \(the industry they filed with the state\)/);
  assert.match(reg, /Small and owner-run/);
  assert.match(reg, /registered with the CT Secretary of the State in 2019/);
  assert.match(reg, /Website: none found/);
});

test('addresses and shell names never go to the CRM', () => {
  assert.equal(hasSubstance({ name: '424 Storrs Road, LLC', email: 'x@gmail.com', contact_name: 'Greg Z', facts: { naics: 'Lessors (531)' } }), false);
  assert.equal(hasSubstance({ name: 'JJC 1232 LLC', email: 'x@gmail.com', contact_name: 'J C', facts: { naics: 'Something (1)' } }), false);
  assert.equal(hasSubstance({ name: 'CBJK, LLC', email: 'x@gmail.com', contact_name: 'C B', facts: {} }), false);
  assert.equal(hasSubstance({ name: 'Rusty Mowers LLC', email: 'r@gmail.com', contact_name: 'Yasmine DelRio', category: 'Landscaping', facts: {} }), true);
  assert.equal(hasSubstance({ name: 'CBJK', website: 'https://cbjk.com', facts: {} }), true, 'a real website makes it real');
});

test('a listed website that is some other business is dropped, not trusted', async () => {
  _resetColumnCache();
  const p = { name: 'Maple Ridge Landscaping', name_key: 'maple ridge landscaping', bucket: 'trades', website: 'https://hartwellcpa.com/', domain: 'hartwellcpa.com', town: 'Tolland', source: 'osm', email: 'mike@mapleridge.com', email_source: 'osm', facts: {} };
  const patch = await enrichProspect(p, { fetchImpl: fakeFetch([]), resolver: okResolver, findWebsite: false });
  assert.equal(patch.website_verified, false);
  assert.equal(patch.website, null);
  assert.equal(patch.facts.website_unverified, 'https://hartwellcpa.com/');
  assert.ok(patch.facts.enrich_notes.some(n => /for a different business/.test(n)));
  const ok = await enrichProspect({ name: 'Willow Creek Family Dentistry', bucket: 'health', website: 'https://willowcreekdental.com/', domain: 'willowcreekdental.com', town: 'Mansfield', source: 'osm', facts: {} }, { fetchImpl: fakeFetch([]), resolver: okResolver });
  assert.equal(ok.website_verified, true);
});

test('CRM card line says what kind of business it is and fits on the card', () => {
  const { cardLine } = require('../lib/outreach/crmnotes');
  assert.equal(cardLine({ facts: { naics: 'Nail Salons (812113)' }, category: 'salon' }), 'Nail salon');
  assert.equal(cardLine({ facts: { naics: 'Residential Remodelers' }, category: 'Builder' }), 'Home remodeling contractor');
  assert.equal(cardLine({ category: 'restaurant' }), 'Restaurant');
  assert.equal(cardLine({ card_line: 'Vegan BBQ food truck', category: 'restaurant' }), 'Vegan BBQ food truck');
  assert.equal(cardLine({}), 'Local business');
});

test('emails that belong to someone else are not used', () => {
  const { emailBelongsElsewhere: e } = require('../lib/outreach/enrich');
  assert.equal(e('rob@dubielcpa.com', 'registry', 'Northeastern Estate Cleanouts & Liquidations'), true);
  assert.equal(e('investorrelations@snapon.com', 'website', 'FCV Tool Supply'), true);
  assert.equal(e('ars@rasi.com', 'registry', 'NES Group'), true);
  assert.equal(e('jordan@apmacct.com', 'registry', 'APM Accounting LLC'), false);
  assert.equal(e('patrick.salkind@coloniallifesales.com', 'registry', 'Salkind Benefit Partners'), false);
  assert.equal(e('owner@gmail.com', 'registry', 'Anything LLC'), false);
});

test('class area: CT, Boston, New York and New England; others stay on the desk', () => {
  const { inClassArea, parsePlace, placeLabel } = require('../lib/outreach/util');
  assert.deepEqual(parsePlace('Boston, MA'), { town: 'Boston', state: 'MA' });
  assert.deepEqual(parsePlace('Mansfield'), { town: 'Mansfield', state: 'CT' });
  assert.equal(inClassArea({ state: 'NY' }), true);
  assert.equal(inClassArea({}), true);
  assert.equal(inClassArea({ state: 'TX' }), false);
  assert.equal(placeLabel({ town: 'Mansfield', state: 'MA' }), 'Mansfield, MA');
  const { composeInitial } = require('../lib/outreach/compose');
  const tx = composeInitial({ id: 't', name: 'Sellmark', town: 'Mansfield', state: 'TX', bucket: 'manufacturing', email: 'a@b.com' }, settings).body;
  assert.doesNotMatch(tx, /Connect\.AI|stop by/);
  const ma = composeInitial({ id: 'm', name: 'Boardwalk Storage', town: 'Mansfield', state: 'MA', bucket: 'trades', email: 'a@b.com' }, settings).body;
  assert.match(ma, /Phone or Zoom/);
  assert.doesNotMatch(ma, /stop by/);
});

test('emails read right for businesses in other states', () => {
  const { composeInitial, shortName } = require('../lib/outreach/compose');
  assert.equal(shortName('S.J. Louis Construction of Texas, Limited Partnership'), 'S.J. Louis Construction of Texas');
  const { subject, body } = composeInitial({ id: 'sj', name: 'S.J. Louis Construction of Texas, Limited Partnership', town: 'Mansfield', state: 'TX', bucket: 'trades', email: 'a@b.com', facts: { shop_tools: ['woocommerce'] } }, settings);
  assert.doesNotMatch(subject + body, /Limited Partnership|WooCommerce/);
  assert.match(body, /Mansfield, Texas/);
  const { parsePlace, stateCode } = require('../lib/outreach/util');
  assert.deepEqual(parsePlace('*, TX'), { town: null, state: 'TX' });
  assert.equal(stateCode('Massachusetts'), 'MA');
});

test('back-office, filing-service and company "names" are not used as contacts', () => {
  const { isFilingAgentEmail } = require('../lib/outreach/sources');
  for (const e of ['accounting@x.com', 'payables@x.com', 'statelicensing@x.com', 'taxdept@x.com', 'info@capitolservices.com', 'ap@x.org']) assert.equal(isFilingAgentEmail(e), true, e);
  for (const e of ['info@rubiconbuilders.com', 'april@x.com', 'jordan@apmacct.com']) assert.equal(isFilingAgentEmail(e), false, e);
  const { cleanPersonName } = require('../lib/outreach/enrich');
  assert.equal(cleanPersonName('Pc Bennett Law Office'), null);
  assert.equal(cleanPersonName('Jason SteelePresident'), 'Jason Steele');
  assert.equal(cleanPersonName('Peter Ponzini Co'), 'Peter Ponzini');
});

test('map businesses: no college departments, no CT filings from other towns, clean emails', () => {
  const { classifyOsm, isChain } = require('../lib/outreach/industries');
  assert.equal(classifyOsm({ name: 'Clark Labs', office: 'yes', website: 'https://www.clarku.edu/geospatial-analytics/' }), null);
  assert.equal(classifyOsm({ name: 'International Center', office: 'yes', email: 'x@springfield.edu' }), null);
  assert.equal(classifyOsm({ name: 'OrthoLazer', healthcare: 'yes' }).category, 'Healthcare practice');
  assert.equal(isChain('Pizzeria Uno'), true);
  const { registryIsLocal, cleanPersonName } = require('../lib/outreach/enrich');
  assert.equal(registryIsLocal({ name: 'FLOUR LLC', city: 'Woodstock', state: 'CT' }, { name: 'Flour', town: 'Cambridge', state: 'MA' }), false);
  assert.equal(registryIsLocal({ name: 'GIOVANNI LLC', city: 'Danbury', state: 'CT' }, { name: 'Giovanni', town: 'Manhattan', state: 'NY' }), false);
  assert.equal(registryIsLocal({ name: 'X LLC', city: 'New York', state: 'NY' }, { name: 'X', town: 'Manhattan', state: 'NY' }), true);
  assert.equal(registryIsLocal({ name: 'X LLC', city: 'Mansfield', state: 'CT' }, { name: 'X', town: 'Mansfield' }), true);
  assert.equal(cleanEmail('hire844-394-2692info@1stoprecruiting.com'), 'info@1stoprecruiting.com');
  assert.equal(cleanEmail('431-7682fireflypotterynh@gmail.com'), 'fireflypotterynh@gmail.com');
  assert.equal(cleanEmail('02909info@thermiapvd.com'), 'info@thermiapvd.com');
  assert.equal(cleanEmail('jamie311@gmail.com'), 'jamie311@gmail.com');
  assert.equal(cleanPersonName('Mark Murphy Mark'), 'Mark Murphy');
});

test('CT businesses from the registry still get the come-by-in-person line', () => {
  const { composeInitial } = require('../lib/outreach/compose');
  const vernon = composeInitial({ id: 'v', name: 'Forte Accounting, LLC', town: 'Vernon', bucket: 'professional', email: 'a@b.com' }, settings).body;
  assert.match(vernon, /stop by since I'm in Storrs/);
  const far = composeInitial({ id: 'f', name: 'Far Shop', town: 'Greenwich', bucket: 'retail', email: 'a@b.com' }, settings).body;
  assert.doesNotMatch(far, /stop by/);
  assert.match(far, /Phone or Zoom/);
});

test("a website for a different business with a shared common word doesn't count", () => {
  const whale = [{ title: 'Plumbing, Heating & Air | Call the Whale', text: 'Call the Whale is a top-rated plumbing, heating and air service provider in Burlington, Vermont.' }];
  assert.equal(siteMatchesBusiness(whale, 'Call the Frog LLC'), false);
  assert.equal(siteMatchesBusiness(whale, 'Call the Whale LLC'), true);
  const plumber = [{ title: 'Smith Plumbing', text: 'Smith Plumbing and Heating serves Coventry.' }];
  assert.equal(siteMatchesBusiness(plumber, 'Smith Plumbing & Heating LLC'), true);
  assert.equal(siteMatchesBusiness(plumber, 'Jones Plumbing LLC'), false);
});

test('drafts that might be the wrong business go to "needs a look", not review', () => {
  const { readinessProblems } = require('../lib/outreach/verify');
  const frog = { name: 'Call the Frog LLC', town: 'Williston', state: 'VT', source: 'registry', email: 'info@callthewhale.com', domain: null,
    registry: { location_from: 'mailing', mailing_state: 'VT' } };
  assert.equal(readinessProblems(frog).length, 2);
  const frogCT = { ...frog, town: 'Groton', state: 'CT' };
  assert.equal(readinessProblems(frogCT).length, 2);
  assert.deepEqual(readinessProblems({ name: "Joe's Pizza LLC", town: 'Mansfield', state: 'CT', email: 'joe@joespizzact.com', domain: 'joespizzact.com' }), []);
  assert.deepEqual(readinessProblems({ name: 'Smith Plumbing', town: 'Coventry', state: 'CT', email: 'smithplumbing@gmail.com' }), []);
  assert.deepEqual(readinessProblems({ name: 'Brand Pet Company LLC', town: 'Vernon', state: 'CT', email: 'cbrandaci@gmail.com', source: 'registry', registry: { location_from: 'office' } }), []);
  const { siteMatchesPlace } = require('../lib/outreach/enrich');
  const whale = [{ title: 'Call the Whale', text: 'Serving the greater Burlington, Vermont area. 4735 Williston Rd #30, Williston, VT 05495' }];
  assert.equal(siteMatchesPlace(whale, { town: 'Groton', state: 'CT' }), false);
  assert.equal(siteMatchesPlace(whale, { town: 'Williston', state: 'VT' }), true);
});
