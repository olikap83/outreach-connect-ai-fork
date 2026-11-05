// Outlook (the Microsoft 365 connector) helpers for the scheduled runs.
//
// - outlookHtml: Outlook's draft tools reject HTML outside a short allowlist
//   (no images, spans, blockquotes, styles or comments), so every email body
//   the scripts build is cleaned down to that.
// - outlookLink: a link that opens one email in Outlook on the web.
// - threadsFromOutlook: turns outlook_email_search results (one object per
//   email) into the { id, messages: [{ id, sender, subject, snippet }] }
//   "threads" the reply planner reads, one per sender, oldest first.

const ALLOWED = new Set(['p', 'br', 'a', 'div', 'b', 'strong', 'i', 'em', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'pre', 'code', 'strike']);

function outlookHtml(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<[!?][^>]*>/g, '');
  s = s.replace(/<(style|script|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<blockquote\b/gi, '<div').replace(/<\/blockquote\s*>/gi, '</div>');
  return s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (m, close, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return '';
    if (close) return `</${t}>`;
    if (t === 'a') {
      const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
      const url = href ? (href[2] ?? href[3]) : '';
      return /^(https?:|mailto:)/i.test(url) ? `<a href="${url.replace(/"/g, '&quot;')}">` : '<a>';
    }
    return `<${t}>`;
  });
}

const outlookLink = id => (id ? `https://outlook.live.com/owa/?ItemID=${encodeURIComponent(String(id).replace(/-/g, '/').replace(/_/g, '+'))}&exvsurl=1&viewmodel=ReadMessageItem` : null);

const addrOf = v => String((v && typeof v === 'object' ? ((v.emailAddress || {}).address || v.address || '') : v) || '').toLowerCase();

function isOutlookItem(x) {
  return !!(x && typeof x === 'object' && x.id && !Array.isArray(x.messages) && ('receivedDateTime' in x || 'summary' in x || 'sentDateTime' in x || 'webLink' in x));
}

function threadsFromOutlook(items) {
  const by = new Map();
  for (const m of items) {
    if (!isOutlookItem(m)) continue;
    const sender = addrOf(m.sender || m.from);
    if (!sender) continue;
    if (!by.has(sender)) by.set(sender, new Map());
    by.get(sender).set(m.id, { id: m.id, sender, subject: m.subject || '', snippet: m.summary || m.bodyPreview || '', date: m.receivedDateTime || m.sentDateTime || '' });
  }
  return [...by.values()].map(mm => {
    const messages = [...mm.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return { id: messages[messages.length - 1].id, messages };
  });
}

module.exports = { outlookHtml, outlookLink, threadsFromOutlook, isOutlookItem };
