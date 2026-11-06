Weekday send for {{NAME}}'s outreach desk ({{DESK_URL}}). This fires every hour from 11am to 3pm Eastern. {{FIRST}} set it up at sign-up so approved emails go out on their own, spread through the day so Outlook doesn't see them as spam. All mail goes through {{FIRST}}'s Outlook ({{SENDER_EMAIL}}) with the Microsoft 365 connector (tools mcp__Microsoft_365__*; load them with ToolSearch "+Microsoft_365 outlook" if they're deferred). Each run sends only its share of the day's emails, with a few minutes between each one. "queued" drafts were either approved by {{FIRST}} on the desk or passed the morning pre-send check. Follow-ups also go out on their own.

EVERY email is sent as HTML: pass the htmlBody that scripts/mail-bodies.js (or the follow-up plan) produces, exactly as it is, as `body` with bodyType "html" (it is already cleaned to what Outlook accepts). Never send the plain-text body instead.

CC RULE: every email this run sends or drafts (first emails, follow-ups, replies, notices and alerts) must copy {{CC}} in cc, unless that address is already in To. Before any outlook_send_draft, make sure the draft has it (outlook_update_draft {messageId, cc: [{{CC}}]} if it is missing). Never send without it.

0. Get the code: Artifact tool, action "read", url above, path "research-code.json"; unpack it into ./outreach:
   node -e 'const fs=require("fs"),p=require("path");const {files}=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const [r,t] of Object.entries(files)){const o=p.join("outreach",r);fs.mkdirSync(p.dirname(o),{recursive:true});fs.writeFileSync(o,t)}' <saved file>
   cd outreach && npm install --silent. Load ArtifactData with ToolSearch "select:ArtifactData" if needed. ArtifactData `get` meta/status and save its `settings` object to ./settings.json.

WORK OUT THIS RUN'S SHARE
1. ArtifactData query, collection "prospects", where status == "queued", out_dir ./queued. Note each doc's version.
2. ArtifactData query, collection "prospects", where status == "sent", out_dir ./fu/docs. Note each doc's version. Run node scripts/outreach-followups.js --docs ./fu/docs/prospects --out ./fu/out --max 40 --settings ./settings.json and read ./fu/out/plan.json.
3. Count first emails already sent today (Eastern date of sent_at, across all prospects; query status in sent/followed_up/replied/bounced/not_interested). Daily limit for first emails: settings.daily_cap (default 20). Follow-ups don't count toward it.
4. node scripts/send-slot.js --limit <limit> --sent-today <count> --followups-due <entries in plan.json>. It prints first_quota, followup_quota, gaps_min, first_run and last_run. Send at most first_quota first emails and followup_quota follow-ups this run.
5. If both quotas are 0, skip to PART C (if first_run or last_run) or stop quietly.

SPACING: after each email, before the next one, wait the next number of minutes from gaps_min (Bash run_in_background: sleep <minutes*60>). Never send two emails back to back without the wait.

PART A: approved first emails (up to first_quota)
6. For each queued doc, highest fit_score first, one at a time:
   a. Check it first: the greeting name must match the person the email goes to, the body must not say "Hi there", and the email address and street address must not match one already emailed (status sent/followed_up/replied/bounced; if it does, set status "skipped" with skip_reason). If the greeting fails, set status "needs_check" with check_reason and skip it.
   a2. Classmate check (never skip this): Connect AI crm_list_orgs {q: <the business name without LLC/Inc/Co>, include_closed: true}. If an organization with the same name (ignoring LLC/Inc/punctuation) is owned by anyone other than {{NAME}}, set status "skipped" with skip_reason "Already in the class CRM (owner: <their name>)", crm_org_id null, and a log line saying so; do not email it. If the CRM can't be reached, don't send any first emails this run.
   b. Claim it: ArtifactData update {status: "sending"} with if_version = its version. If refused, re-get it; skip unless it's still "queued" (then claim with the new version).
   c. Build the bodies: node scripts/mail-bodies.js <its saved JSON file> ./settings.json.
   d. Outlook outlook_create_draft {to: [email], cc: [{{CC}}], subject, body: htmlBody from step c, bodyType: "html"}, then outlook_send_draft {messageId: the draft id it returned}. Then find the sent copy: outlook_email_search {recipient: email, afterDateTime: <ISO time 20 minutes ago>, limit: 10} and take the newest result sent by {{SENDER_EMAIL}} with the same subject (try again once after 10 seconds if it isn't there yet).
   e. Update the doc (pinned to the claim's version): status "sent", sent_at now (ISO), thread_id and message_id = that sent copy's id (or the draft id if it wasn't found), updated_at now, and append to log {at: now, what: "Emailed <contact_name> at <email>"} (or "Emailed <email>").
   f. Class CRM (Connect AI), if crm_org_id is set: node scripts/crm-entry.js <its saved JSON file> --sent-at <sent_at> --settings ./settings.json. Then crm_log_touchpoint {org: crm_org_id, ...touchpoint} (if the contact name is refused, retry without contact), and crm_update_org {org: crm_org_id, ...update}. If add_contact is set and crm_get_org shows no contacts, crm_add_contact {org: crm_org_id, ...add_contact}. Then update the doc crm_stage "contacted".
   g. If the Outlook send fails, set the doc back to "queued" with a log line naming the error; keep going.

PART B: automatic follow-ups (up to followup_quota; one per business, after 4 business days with no reply)
7. Check Outlook for replies and bounces: for each address in plan.json, outlook_email_search {sender: address, afterDateTime: <ISO time 30 days ago>, limit: 5}; and once, outlook_email_search {query: "Undeliverable", afterDateTime: <ISO time 30 days ago>, limit: 25} (a bounce names the address in its summary). Skip anyone who wrote back or bounced (mark bounced ones "bounced"). For each remaining entry, oldest first:
   a. Claim: ArtifactData update {status: "sending"} with if_version; skip if refused and it's no longer "sent".
   b. Outlook outlook_create_reply_all_draft {messageId: thread_id, body: htmlBody from the plan, bodyType: "html"}, then outlook_update_draft {messageId: that draft's id, to, cc: [{{CC}}], subject} from the plan so it goes only to the business (and cc), then outlook_send_draft {messageId: that draft's id}.
   c. ArtifactData update with file_path = after_file, pinned to the claim's version. If the send failed, set status back to "sent" with a log line.
   d. If "crm" is set: crm_log_touchpoint {org: crm.org, kind: "email", body: crm.body} and crm_update_org {org: crm.org, ...crm.update}.

8. Only on the last run of the day (last_run true): say in one or two plain sentences how many first emails and follow-ups went out today, how many are still queued, and anything held back or failed.

PART C: health check (first and last run of the day only)
9. Problems to look for: an Outlook send failed, or a doc is still "sending" from an earlier run (over an hour old); meta/status has `blocked` set, or last_run_at is more than 2 days old on a weekday; fewer than 15 "ready" drafts left; anything else that stopped part of this run.
10. If any problem is found, send ONE email with Outlook outlook_send_mail to [{{NOTIFY}}], subject "Outreach desk: something needs a look", plain-text body listing each problem in a plain sentence (what happened, what it means for today's emails, whether it fixes itself), ending with the desk link. Don't send the same problem twice in one day. If nothing is wrong, send nothing.
