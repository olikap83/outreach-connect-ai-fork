-- Run after 006_discover_domains.sql.
-- Business outreach: sourcing small CT businesses, finding a real contact,
-- writing a personal email, sending it from your own Gmail, and tracking
-- replies. Powers /outreach and api/outreach.js.
--
-- Unlike the alumni tables, these are NOT publicly readable: they hold
-- email drafts and the replies businesses send back. Row level security is
-- on with no policies, so the anon key in config.js can't read or write
-- them. Only api/outreach.js can, using SUPABASE_SERVICE_ROLE_KEY (set on
-- Vercel, never in client code), and only after checking OUTREACH_KEY.

create extension if not exists pgcrypto;

create table if not exists outreach_prospects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null,              -- normalized name, for dedupe
  category text,                       -- plain words: "Dentist", "Plumber"
  bucket text,                         -- trades | health | food | ... (drives the email's idea line)
  website text,
  domain text,
  phone text,
  address text,
  town text,
  state text not null default 'CT',
  lat double precision,
  lon double precision,
  miles_from_storrs numeric,
  source text not null,                -- osm | registry | manual
  source_ref text,                     -- OSM element id / registry id
  registry jsonb,                      -- what the CT business registry says, if matched
  contact_name text,
  contact_title text,
  email text,
  email_source text,                   -- website | osm | registry | guess | manual
  email_confidence text,               -- high | medium | low
  facts jsonb not null default '{}'::jsonb,
  fit_score int,
  fit_reasons jsonb not null default '[]'::jsonb,
  status text not null default 'new',  -- new | ready | queued | sent | followed_up | replied | not_interested | bounced | skipped | no_email
  notes text,
  crm_org_id text,
  crm_synced_at timestamptz,
  last_error text,
  enrich_attempts int not null default 0,
  enriched_at timestamptz,
  sent_at timestamptz,
  followup_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name_key, town)
);

create index if not exists outreach_prospects_status_idx on outreach_prospects (status);
create index if not exists outreach_prospects_email_idx on outreach_prospects (lower(email));
create index if not exists outreach_prospects_updated_idx on outreach_prospects (updated_at desc);

create table if not exists outreach_messages (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references outreach_prospects(id) on delete cascade,
  kind text not null,                  -- initial | followup | reply
  direction text not null default 'out', -- out | in
  subject text,
  body text,
  status text not null default 'draft', -- draft | queued | sent | failed | received
  to_email text,
  from_email text,
  message_id text unique,              -- RFC 5322 Message-ID, for threading + reply matching
  in_reply_to text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists outreach_messages_prospect_idx on outreach_messages (prospect_id, created_at);
create index if not exists outreach_messages_sent_idx on outreach_messages (sent_at desc);

create table if not exists outreach_events (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid references outreach_prospects(id) on delete cascade,
  kind text not null,                  -- sourced | enriched | drafted | approved | sent | followup | replied | bounced | opted_out | skipped | crm | error | run
  body text,
  created_at timestamptz not null default now()
);

create index if not exists outreach_events_created_idx on outreach_events (created_at desc);

-- One row, id = 1. Everything the dashboard's Settings panel edits.
create table if not exists outreach_settings (
  id int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into outreach_settings (id, data) values (1, '{}'::jsonb) on conflict (id) do nothing;

-- Towns the sourcer sweeps, least-recently-swept first. Seeded with towns
-- within roughly 35 miles of Storrs, since partners get a weekly visit.
create table if not exists outreach_towns (
  town text primary key,
  enabled boolean not null default true,
  last_sourced_at timestamptz,
  last_found int,
  created_at timestamptz not null default now()
);

insert into outreach_towns (town) values
  ('Mansfield'), ('Windham'), ('Coventry'), ('Tolland'), ('Vernon'), ('Manchester'),
  ('Ellington'), ('Stafford'), ('Willington'), ('Ashford'), ('Columbia'), ('Hebron'),
  ('Lebanon'), ('Bolton'), ('Andover'), ('Glastonbury'), ('South Windsor'), ('East Hartford'),
  ('Norwich'), ('Colchester'), ('Enfield'), ('Somers'), ('East Windsor'), ('Windsor'),
  ('Killingly'), ('Putnam'), ('Plainfield'), ('Brooklyn'), ('Pomfret'), ('Woodstock'),
  ('Thompson'), ('Hartford'), ('West Hartford'), ('Wethersfield'), ('Rocky Hill'), ('Middletown')
on conflict (town) do nothing;

-- Businesses we must not cold-email: anything already in the class CRM
-- (a classmate may be talking to them) plus anything added by hand.
-- Seeded with the CRM's organizations as of 2026-10-28; api/outreach.js
-- refreshes it from the CRM when CONNECT_AI_MCP_URL is set.
create table if not exists outreach_excluded (
  name_key text primary key,
  name text not null,
  reason text,
  created_at timestamptz not null default now()
);

insert into outreach_excluded (name_key, name, reason) values
  ('amodex products', 'Amodex Products Inc.', 'In class CRM'),
  ('cnm heating cooling piping', 'CNM Heating Cooling Piping', 'In class CRM'),
  ('coastal bridge advisors', 'Coastal Bridge Advisors', 'In class CRM'),
  ('commerce packaging', 'Commerce Packaging', 'In class CRM'),
  ('connecticut wealth management', 'Connecticut Wealth Management', 'In class CRM'),
  ('dutch point credit union', 'Dutch Point Credit Union', 'In class CRM'),
  ('fd community federal credit union', 'FD Community Federal Credit Union', 'In class CRM'),
  ('hosmer mountain soda', 'Hosmer Mountain Soda', 'In class CRM'),
  ('insurbanc', 'InsurBanc', 'In class CRM'),
  ('k l smith agency', 'K.L. Smith Agency LLC', 'In class CRM'),
  ('munsons chocolates', 'Munson''s Chocolates', 'In class CRM'),
  ('farmers cow', 'The Farmer''s Cow', 'In class CRM'),
  ('thehoot', 'TheHoot', 'In class CRM'),
  ('clancys hiit fit', 'Clancy’s HIIT & Fit', 'In class CRM'),
  ('dri air industries', 'Dri-Air Industries', 'In class CRM'),
  ('eastern insurance associates', 'Eastern Insurance Associates', 'In class CRM'),
  ('ellington agway', 'Ellington Agway', 'In class CRM'),
  ('kmb jaworski plumbing remodeling', 'KMB Jaworski Plumbing & Remodeling', 'In class CRM'),
  ('mansfield family dental', 'Mansfield Family Dental', 'In class CRM'),
  ('new park creative', 'New Park Creative', 'In class CRM'),
  ('olympic family restaurant', 'Olympic Family Restaurant', 'In class CRM'),
  ('schillers sewing circle', 'Schiller’s Sewing Circle', 'In class CRM'),
  ('cornerstone foundation', 'The Cornerstone Foundation', 'In class CRM'),
  ('united gear machine', 'United Gear & Machine Co.', 'In class CRM'),
  ('elm city internationals', 'Elm City Internationals', 'In class CRM'),
  ('trachten law firm', 'Trachten Law Firm LLC', 'In class CRM'),
  ('south farms hospitality', 'South Farms Hospitality, LLC', 'In class CRM'),
  ('ctsbdc', 'CTSBDC', 'In class CRM'),
  ('gold trader', 'The Gold Trader', 'In class CRM')
on conflict (name_key) do nothing;

alter table outreach_prospects enable row level security;
alter table outreach_messages enable row level security;
alter table outreach_events enable row level security;
alter table outreach_settings enable row level security;
alter table outreach_towns enable row level security;
alter table outreach_excluded enable row level security;
-- No policies on purpose: service role only.
