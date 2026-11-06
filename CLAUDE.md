# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Connect.AI outreach desk: each UConn student in the class runs their own copy on their own Claude account. It finds small businesses (OpenStreetMap + the CT business registry), reads their websites for an owner and email, drafts a personal first email, sends approved ones from the student's Outlook, watches for replies, and logs everything to the class CRM (connect-ai.world/crm, reached through the "Connect.AI" connector). `SETUP.md` is the step-by-step a Claude session follows to set up a new student's desk; read it before changing anything the setup depends on.

## Commands

```bash
npm install
npm test                                   # all tests, offline (every network call is faked)
OUTREACH_NO_PROFILE=1 node --test --test-name-pattern "same template" test/outreach.test.js   # one test by name
node scripts/bundle-for-desk.js > research-code.json   # rebuild the code bundle the desk publishes
```

`OUTREACH_NO_PROFILE=1` matters: without it, `loadSettings()` (lib/outreach/settings.js) silently loads the student's own `profile.json` from the repo root, and tests written against the fixture settings fail. `profile.json` and `research-code.json` are git-ignored and hold the student's personal details.

Research by hand (needs network):

```bash
node scripts/outreach-batch.js --find --known known.json --out out --towns 4 --max 40 --pause 30
node scripts/outreach-batch.js --research --start 0 --count 5 --out out
node scripts/osm-probe.js 'Worcester, MA'
```

## Architecture

Three parts, and the code is shared between them through a bundle:

1. **The desk page** (`artifact/outreach-desk.html`): one self-contained claude.ai artifact (no build step). Its data lives in the artifact database (`prospects/<id>` docs and `meta/status`, whose `settings` field is the student's profile). It calls connectors through the artifact `mcp` capability: `Connect.AI` for the CRM and `Microsoft 365` for mail. The server names must equal the connector display names exactly, or claude.ai shows "No matching connector found". It also uses `sample` (Claude drafts replies and prep sheets) and `user` (anyone but the owner gets a read-only view).

2. **Scheduled routines** (`setup/routines/*.md`): prompt templates with `{{PLACEHOLDERS}}`. SETUP.md fills them in and creates them as claude.ai routines: daily research, pre-send check, weekday sends and reply watch. Each run reads `research-code.json` *from the published desk* (Artifact read, path `research-code.json`), unpacks it, and runs `scripts/*`. **Changing anything under `lib/` or `scripts/` does nothing for live desks until you rebuild the bundle and republish the desk with it.** Editing a template doesn't update existing routines either; those are changed with `update_trigger`.

3. **The research and email code** (`lib/outreach/`, `scripts/`): plain Node, no network in tests.
   - `sources.js` → `enrich.js` → `industries.js` / `score.js` → `compose.js` → `crmnotes.js` is the research pipeline, driven by `scripts/outreach-batch.js`.
   - `factsources.js`: every fact shown or used in an email must keep a source URL; facts without one are dropped (`keepSourced`). The same rule is repeated in the desk page (`factUrl`, `nameSource`).
   - `settings.js`: every per-student field and its default; `profileOf()` derives `signature`, `notify_emails`, etc. Nothing about a student is hard-coded anywhere.
   - `scripts/outreach-preflight.js` re-verifies drafts against the business's site and filing before auto-approval; `outreach-followups.js`, `outreach-replies.js`, `meeting-reply.js`, `reply-notice.js`, `mail-bodies.js` and `send-slot.js` produce exactly what the routines send.

The desk page duplicates several pieces of library logic in its own JS (greeting/name checks, CRM notes, auto-reply and opt-out patterns, `mailBodies`). Changes to that behavior usually need making in both places.

## Mail goes through Outlook, not Gmail

The code was written against Gmail and then ported to the Microsoft 365 (Outlook) connector:
- In the desk, `mailCall()` translates the old Gmail-style actions (`send_message`, `reply`, `create_draft`, `get_thread`) into Outlook tool calls. It sends by creating a draft and then sending it, then looks up the Sent Items copy so its id can be the `thread_id` for follow-ups (`outlook_create_reply_all_draft` + `outlook_update_draft`). Reply watching polls Inbox/search results, not per-sender queries.
- `withSchoolCc()` adds the student's `cc_email` (else `school_email`) to every outgoing message, and to routine-written drafts just before they're sent. The routine templates carry the same "CC RULE".
- Outlook's draft tools *reject* HTML outside a small allowlist (no `img`, `span`, `blockquote`, styles or comments). Every HTML body goes through `outlookHtml()` (`lib/outreach/outlook.js` for Node, a DOM version in the desk).
- `lib/outreach/outlook.js` also has `threadsFromOutlook()`. `scripts/outreach-replies.js plan --threads` accepts raw `outlook_email_search` result objects (one JSON per line) and groups them per sender into the thread shape `planReplies` expects.
- `mailer.js`, `engine.js`, `store.js`, `crm.js` and `supabase/` are the original Vercel/Supabase/Gmail-app-password version. They're still tested but not used by the desk.

## First-email template

`composeInitial()` (lib/outreach/compose.js) writes one fixed template. Only the business-specific parts change:

```
Hello <name | Business team>,

<settings.intro, word for word; fallback: settings.why without its closing question>

I've always been interested in <industries.js bucket interest>. <one sourced detail, optional> I'd love to hear how you got <Business> going and what you wish you'd known at the start.

Would you have 15 minutes for a call sometime?

If now isn't a good time, no worries at all.

Thanks,
<settings.signature>
```

Greetings are "Hello …". Code that reads a greeting back accepts both `Hi` and `Hello` (`/^(?:Hi|Hello) /`). A standalone "LinkedIn" in the signature becomes a link to `linkedin_url` in the HTML body. `scripts/outreach-redraft.js` rewrites existing unsent drafts into the current format and leaves hand-edited ones alone (identified by log lines like "Edited the draft" or "Saved as an Outlook draft").

## Rules the code enforces (keep them)

- Never greet by a name that can't be tied to the business's own website or to the email address (`confirmName`, `nameConfirmed`); otherwise use "Hello <Business> team,". "Dr." only when a source shows the person is a doctor.
- Class-area businesses (CT, MA, RI, NH, VT, ME, NY) go to the class CRM. A business already in the CRM under another student is skipped, not emailed. `crm_create_org` refuses duplicate names, which is the backstop.
- Sending is spread out: `send-slot.js` sets per-hour quotas and gaps under `settings.daily_cap`; the desk's own `autoSend` is deliberately disabled.
