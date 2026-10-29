// Sending and reading mail through your own Gmail account. Free: it
// uses a Gmail "app password" over SMTP (to send) and IMAP (to see who
// replied), the same way a desktop mail app would. No Google Cloud
// project, no API quota, and sent mail shows up in your Sent folder like
// anything else you send.
//
// Env (set on Vercel):
//   GMAIL_USER          you@gmail.com
//   GMAIL_APP_PASSWORD  16-character app password (Google Account →
//                       Security → 2-Step Verification → App passwords)
// Optional, for a non-Gmail account: SMTP_HOST/SMTP_PORT, IMAP_HOST/IMAP_PORT.

const { FREEMAIL } = require('./sources');

function mailConfig() {
  const user = process.env.GMAIL_USER || process.env.SMTP_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS || '').replace(/\s+/g, '');
  return {
    user,
    pass,
    smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: Number(process.env.SMTP_PORT || 465),
    imapHost: process.env.IMAP_HOST || 'imap.gmail.com',
    imapPort: Number(process.env.IMAP_PORT || 993),
    configured: !!(user && pass),
  };
}

let transport = null;
function getTransport() {
  if (transport) return transport;
  const c = mailConfig();
  if (!c.configured) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    secure: c.smtpPort === 465,
    auth: { user: c.user, pass: c.pass },
  });
  return transport;
}

// Returns { messageId }. Follow-ups pass inReplyTo so they thread under
// the first email in the owner's inbox.
async function sendMail({ to, subject, text, fromName, inReplyTo, references }) {
  const c = mailConfig();
  const info = await getTransport().sendMail({
    from: fromName ? { name: fromName, address: c.user } : c.user,
    to,
    subject,
    text,
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
  });
  return { messageId: info.messageId };
}

const OPT_OUT = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting)|not interested|no thanks|no thank you|please don'?t (email|contact)|do not (email|contact)|we('| a)re all set|we are not interested|we'?ll pass|not at this time)\b/i;
const AUTO_REPLY_SUBJECT = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|away from (the|my) office|on vacation|delivery status notification|undeliverable|mail delivery (failed|subsystem)|returned mail|delivery failure|failure notice)/i;

// Strip quoted history so the snippet is what they actually wrote.
function freshText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^On .{5,200}wrote:\s*$/i.test(line)) break;
    if (/^-{2,}\s*Original Message/i.test(line)) break;
    if (/^From:\s.+/i.test(line) && out.length) break;
    if (/^Sent from my (iPhone|iPad|Android|Samsung)/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function classifyIncoming({ fromAddress, subject, headers, text }) {
  const from = String(fromAddress || '').toLowerCase();
  const subj = String(subject || '');
  const auto = String(headers['auto-submitted'] || '').toLowerCase();
  if (/mailer-daemon|postmaster@|mail delivery/i.test(from) || /undeliverable|delivery status notification|failure notice|returned mail|address not found/i.test(subj)) {
    return 'bounce';
  }
  if ((auto && auto !== 'no') || headers['x-autoreply'] || headers['x-autorespond'] || AUTO_REPLY_SUBJECT.test(subj)) return 'auto_reply';
  const fresh = freshText(text).slice(0, 600);
  if (OPT_OUT.test(fresh)) return 'not_interested';
  return 'reply';
}

/**
 * Read recent inbox mail and match it to prospects.
 * known: { emails: Map(lowerEmail → prospectId), domains: Map(domain → prospectId), messageIds: Map(id → prospectId) }
 * Returns [{ prospectId, kind, messageId, fromAddress, subject, snippet, date, bouncedAddress }]
 */
async function checkInbox(known, { sinceDays = 3, max = 200 } = {}) {
  const c = mailConfig();
  if (!c.configured) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({ host: c.imapHost, port: c.imapPort, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  const results = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - sinceDays * 86400000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      const recent = uids.slice(-max);
      if (!recent.length) return results;
      // First pass: envelopes only (cheap). Second pass: full source just for matches.
      const matches = [];
      for await (const msg of client.fetch(recent, { envelope: true, uid: true }, { uid: true })) {
        const env = msg.envelope || {};
        const fromAddress = (env.from?.[0]?.address || '').toLowerCase();
        const inReplyTo = env.inReplyTo || '';
        let prospectId = known.messageIds.get(inReplyTo) || known.emails.get(fromAddress);
        if (!prospectId) {
          const dom = fromAddress.split('@')[1];
          if (dom && !FREEMAIL.has(dom)) prospectId = known.domains.get(dom);
        }
        const isDaemon = /mailer-daemon|postmaster/i.test(fromAddress);
        if (prospectId || isDaemon) matches.push({ uid: msg.uid, prospectId, env, fromAddress });
      }
      for (const m of matches) {
        const msg = await client.fetchOne(String(m.uid), { source: true }, { uid: true });
        if (!msg?.source) continue;
        const parsed = await simpleParser(msg.source);
        const headers = Object.fromEntries([...parsed.headers.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
        const text = parsed.text || '';
        let prospectId = m.prospectId;
        let bouncedAddress = null;
        const kind = classifyIncoming({ fromAddress: m.fromAddress, subject: parsed.subject, headers, text });
        if (kind === 'bounce') {
          const failed = String(headers['x-failed-recipients'] || '').toLowerCase().trim();
          const body = `${failed}\n${text}`.toLowerCase();
          for (const [email, id] of known.emails) {
            if (body.includes(email)) { prospectId = id; bouncedAddress = email; break; }
          }
          const refs = String(parsed.inReplyTo || '') + ' ' + String(headers.references || '');
          if (!prospectId) for (const [mid, id] of known.messageIds) if (refs.includes(mid) || body.includes(mid.replace(/[<>]/g, ''))) { prospectId = id; break; }
        }
        if (!prospectId) continue;
        results.push({
          prospectId,
          kind,
          messageId: parsed.messageId || `<uid-${m.uid}@inbox>`,
          inReplyTo: parsed.inReplyTo || null,
          fromAddress: m.fromAddress,
          subject: parsed.subject || '',
          snippet: freshText(text).slice(0, 1200),
          date: (parsed.date || new Date()).toISOString(),
          bouncedAddress,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return results;
}

module.exports = { mailConfig, sendMail, checkInbox, classifyIncoming, freshText, OPT_OUT };
