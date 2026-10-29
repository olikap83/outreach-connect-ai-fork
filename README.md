# Connect.AI Outreach Desk

Soham Shah's tool for reaching out to small businesses for Connect.AI, a UConn course where student teams help small businesses use AI.

It finds small businesses, reads their websites for the owner and an email address, and writes each one a personal email in a student's voice. Soham reviews and sends them from his own Gmail. Every business in the class area (Connecticut, Boston, New York and the rest of New England) is also added to the class CRM at connect-ai.world/crm.

## How it fits together

- **The desk** (`artifact/outreach-desk.html`) is a private page on claude.ai. It holds every business and draft, sends email through Gmail (cc his UConn address), sends approved emails on weekday mornings, shows replies, drafts answers and call prep sheets with Claude, and logs everything to the class CRM.
- **The daily research run** is a scheduled Claude session (weekdays, 7:47am New York). It checks out this repo, runs `scripts/outreach-batch.js` to find and research a few places, and writes the results onto the desk a few at a time.
- **The research code** is in `lib/outreach/`:
  - `sources.js`: where businesses come from. OpenStreetMap (radius search around each town or city center) and the CT business registry on data.ct.gov (Connecticut towns only).
  - `enrich.js`: reads each business's website for the owner, an email and details (years in business, booking tools, hiring and so on). It throws out emails that belong to someone else, like an accountant or filing agent, and owner names from unrelated registry filings.
  - `industries.js`: what kind of business it is, and what to skip (chains, colleges, hospitals, government).
  - `score.js`: the fit score.
  - `compose.js`: the email draft.
  - `crmnotes.js`: the description and card line for the class CRM.

## Scripts

```
node scripts/outreach-batch.js --find --known known.json --out out --towns 4 --max 40 --pause 30
node scripts/outreach-batch.js --research --start 0 --count 5 --out out
node scripts/outreach-batch.js --find --places 'Boston, MA|Providence, RI' --osm-only --known known.json --out out
node scripts/osm-probe.js 'Worcester, MA'
```

## Tests

```
npm install
npm test
```

Everything external (websites, the registry, OpenStreetMap, Gmail, the CRM) is faked in the tests, so they run offline and never send anything.

## Older server version

`lib/outreach/engine.js`, `store.js`, `mailer.js` and `crm.js` (and `supabase/migrations/007_outreach.sql`) are from the first version, which ran on Vercel and Supabase with a Gmail app password. The tests still cover them, but the desk on claude.ai replaced that setup.
