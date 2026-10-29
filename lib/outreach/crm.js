// Keeps the class CRM (connect-ai.world/crm) in step with outreach:
//   - email sent      → org created as "Contacted" (owner: you), contact
//                       added, the email logged on its timeline, and a
//                       follow-up next step set
//   - reply received  → reply logged, next step "Reply to <name>" due today
//   - "no thanks"     → moved to "Not now"
//
// The CRM is reached the same way Claude reaches it: its MCP server. This
// is a minimal MCP client (JSON-RPC over HTTP). Set on Vercel:
//   CONNECT_AI_MCP_URL   the Connect.AI MCP server URL
//   CONNECT_AI_API_KEY   a key from the CRM page's "API keys" button
// Without them, sync is skipped and the dashboard says so; nothing else
// breaks.

function crmConfig() {
  return {
    url: process.env.CONNECT_AI_MCP_URL || '',
    key: process.env.CONNECT_AI_API_KEY || '',
    configured: !!(process.env.CONNECT_AI_MCP_URL && process.env.CONNECT_AI_API_KEY),
  };
}

// MCP servers answer either plain JSON or a one-shot SSE stream.
async function readRpc(resp) {
  const type = resp.headers.get('content-type') || '';
  const text = await resp.text();
  if (type.includes('text/event-stream')) {
    const datas = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
    for (let i = datas.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(datas[i]);
        if (msg.result || msg.error) return msg;
      } catch (e) { /* keep looking */ }
    }
    throw new Error('MCP: no result in event stream');
  }
  return text ? JSON.parse(text) : {};
}

let session = null;

async function rpc(method, params, { notify = false, fetchImpl = fetch } = {}) {
  const c = crmConfig();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${c.key}`,
    'MCP-Protocol-Version': '2025-06-18',
  };
  if (session) headers['Mcp-Session-Id'] = session;
  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: Date.now() + Math.random(), method, params };
  const resp = await fetchImpl(c.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const sid = resp.headers.get('mcp-session-id');
  if (sid) session = sid;
  if (notify) return null;
  if (!resp.ok) throw new Error(`MCP HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  const msg = await readRpc(resp);
  if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
  return msg.result;
}

let ready = false;
async function ensureSession(fetchImpl = fetch) {
  if (ready) return;
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'connect-ai-outreach', version: '1.0.0' },
  }, { fetchImpl });
  await rpc('notifications/initialized', {}, { notify: true, fetchImpl }).catch(() => {});
  ready = true;
}

async function callTool(name, args, fetchImpl = fetch) {
  await ensureSession(fetchImpl);
  const result = await rpc('tools/call', { name, arguments: args }, { fetchImpl });
  const text = (result?.content || []).map(c => c.text || '').join('');
  if (result?.isError) throw new Error(text || `${name} failed`);
  try { return JSON.parse(text); } catch (e) { return { text }; }
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Called after the first email goes out. Returns the CRM org id.
async function syncSent(p, message, { todayYmd, followupDays = 4, fetchImpl = fetch } = {}) {
  const contact = p.contact_name
    ? { full_name: p.contact_name, email: p.email || undefined, title: p.contact_title || undefined, is_primary: true }
    : undefined;
  let org;
  try {
    org = await callTool('crm_create_org', {
      name: p.name,
      kind: 'business',
      stage: 'contacted',
      owner: 'me',
      source: 'outreach',
      city: p.town || undefined,
      state: p.state || 'CT',
      website: p.domain || p.website || undefined,
      industry: p.category || undefined,
      headcount: p.facts?.team_size_text ? String(p.facts.team_size_text) : undefined,
      next_step: 'Follow up on intro email if no reply',
      next_step_due: addDays(todayYmd, followupDays + 2),
      notes: `Found through automated outreach (fit ${p.fit_score}/100). ${(p.fit_reasons || []).slice(0, 4).map(r => r.why).join('; ')}`.slice(0, 3900),
      contact,
    }, fetchImpl);
  } catch (err) {
    throw new Error(`crm_create_org: ${err.message}`);
  }
  const id = org?.id || org?.org?.id || org?.existing?.id;
  if (!id) throw new Error(`crm_create_org returned no id: ${JSON.stringify(org).slice(0, 200)}`);
  if (!contact && p.email) {
    await callTool('crm_add_contact', { org: id, full_name: p.name, email: p.email, notes: 'General inbox' }, fetchImpl).catch(() => {});
  }
  await callTool('crm_log_touchpoint', {
    org: id,
    kind: 'email',
    contact: p.contact_name || undefined,
    body: `Intro email sent to ${p.email}.\nSubject: ${message.subject}\n\n${message.body}`.slice(0, 3990),
  }, fetchImpl);
  return id;
}

async function syncFollowup(p, message, fetchImpl = fetch) {
  if (!p.crm_org_id) return;
  await callTool('crm_log_touchpoint', {
    org: p.crm_org_id, kind: 'email', contact: p.contact_name || undefined,
    body: `Follow-up email sent to ${p.email}.\n\n${message.body}`.slice(0, 3990),
  }, fetchImpl);
}

async function syncReply(p, reply, { todayYmd, fetchImpl = fetch } = {}) {
  if (!p.crm_org_id) return;
  await callTool('crm_log_touchpoint', {
    org: p.crm_org_id, kind: 'email', contact: p.contact_name || undefined,
    body: `${reply.kind === 'not_interested' ? 'Replied (not interested)' : 'Replied'} from ${reply.fromAddress}:\n\n${reply.snippet}`.slice(0, 3990),
  }, fetchImpl);
  if (reply.kind === 'not_interested') {
    await callTool('crm_update_org', { org: p.crm_org_id, stage: 'passed', next_step: null, next_step_due: null }, fetchImpl);
  } else {
    await callTool('crm_update_org', { org: p.crm_org_id, next_step: `Reply to ${p.contact_name || p.name}`, next_step_due: todayYmd }, fetchImpl);
  }
}

// Every org name in the CRM, so we never cold-email someone a classmate
// is already talking to.
async function listCrmNames(fetchImpl = fetch) {
  const res = await callTool('crm_list_orgs', { limit: 200, include_closed: true }, fetchImpl);
  return (res?.orgs || []).map(o => o.name).filter(Boolean);
}

module.exports = { crmConfig, callTool, syncSent, syncFollowup, syncReply, listCrmNames, readRpc, _reset: () => { session = null; ready = false; } };
