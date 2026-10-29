// Storage for the outreach pipeline. SupabaseStore is what runs on
// Vercel; MemoryStore is the same interface in memory, used by the tests
// (and handy for trying the engine locally without a database).

const { mergeSettings } = require('./settings');

const LIST_COLUMNS = 'id,name,category,bucket,town,email,email_source,email_confidence,contact_name,contact_title,fit_score,status,website,domain,miles_from_storrs,source,sent_at,followup_at,replied_at,updated_at,created_at,last_error,crm_org_id';

class SupabaseStore {
  constructor(client) {
    this.db = client;
  }

  async _q(promise) {
    const { data, error, count } = await promise;
    if (error) throw new Error(error.message);
    return count != null && data == null ? count : data;
  }

  async getSettings() {
    const rows = await this._q(this.db.from('outreach_settings').select('data').eq('id', 1));
    return mergeSettings(rows?.[0]?.data);
  }

  async getRawSettings() {
    const rows = await this._q(this.db.from('outreach_settings').select('data').eq('id', 1));
    return rows?.[0]?.data || {};
  }

  async saveSettings(data) {
    await this._q(this.db.from('outreach_settings').upsert({ id: 1, data, updated_at: new Date().toISOString() }));
  }

  async listProspects({ statuses, limit = 1000, order = 'updated_at', ascending = false, full = false, maxAttempts } = {}) {
    let q = this.db.from('outreach_prospects').select(full ? '*' : LIST_COLUMNS);
    if (statuses) q = q.in('status', statuses);
    if (maxAttempts != null) q = q.lt('enrich_attempts', maxAttempts);
    q = q.order(order, { ascending, nullsFirst: false }).limit(limit);
    return this._q(q);
  }

  async getProspect(id) {
    const rows = await this._q(this.db.from('outreach_prospects').select('*').eq('id', id).limit(1));
    return rows?.[0] || null;
  }

  async knownKeys() {
    const rows = await this._q(this.db.from('outreach_prospects').select('name_key,domain').limit(20000));
    return {
      names: new Set(rows.map(r => r.name_key)),
      domains: new Set(rows.map(r => r.domain).filter(Boolean)),
    };
  }

  async insertProspects(rows) {
    if (!rows.length) return [];
    return this._q(this.db.from('outreach_prospects').upsert(rows, { onConflict: 'name_key,town', ignoreDuplicates: true }).select('id,name'));
  }

  async updateProspect(id, patch) {
    await this._q(this.db.from('outreach_prospects').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id));
  }

  // Atomically move a prospect from one status to another. Returns false
  // if someone else (an overlapping run) already moved it.
  async claim(id, fromStatus, toStatus) {
    const rows = await this._q(this.db.from('outreach_prospects')
      .update({ status: toStatus, updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', fromStatus).select('id'));
    return rows.length === 1;
  }

  async countByStatus() {
    const rows = await this._q(this.db.from('outreach_prospects').select('status').limit(20000));
    const out = {};
    for (const r of rows) out[r.status] = (out[r.status] || 0) + 1;
    return out;
  }

  async listMessages(prospectId) {
    return this._q(this.db.from('outreach_messages').select('*').eq('prospect_id', prospectId).order('created_at', { ascending: true }));
  }

  async insertMessage(m) {
    const rows = await this._q(this.db.from('outreach_messages').insert(m).select('*'));
    return rows[0];
  }

  async updateMessage(id, patch) {
    await this._q(this.db.from('outreach_messages').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id));
  }

  async messageExists(messageId) {
    const rows = await this._q(this.db.from('outreach_messages').select('id').eq('message_id', messageId).limit(1));
    return rows.length > 0;
  }

  async sentMessageIndex() {
    return this._q(this.db.from('outreach_messages').select('prospect_id,message_id').eq('direction', 'out').eq('status', 'sent').not('message_id', 'is', null).limit(20000));
  }

  async sentCountSince(date) {
    const { count, error } = await this.db.from('outreach_messages')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'out').eq('status', 'sent').gte('sent_at', date.toISOString());
    if (error) throw new Error(error.message);
    return count || 0;
  }

  async sentSeries(sinceDate) {
    return this._q(this.db.from('outreach_messages').select('sent_at,kind,direction,status').gte('created_at', sinceDate.toISOString()).in('status', ['sent', 'received']).limit(5000));
  }

  async addEvent(prospectId, kind, body) {
    await this._q(this.db.from('outreach_events').insert({ prospect_id: prospectId || null, kind, body: body ? String(body).slice(0, 2000) : null }));
  }

  async listEvents({ limit = 60, prospectId } = {}) {
    let q = this.db.from('outreach_events').select('id,prospect_id,kind,body,created_at').order('created_at', { ascending: false }).limit(limit);
    if (prospectId) q = q.eq('prospect_id', prospectId);
    return this._q(q);
  }

  async listTowns() {
    return this._q(this.db.from('outreach_towns').select('*').order('town'));
  }

  async upsertTown(row) {
    await this._q(this.db.from('outreach_towns').upsert(row));
  }

  async deleteTown(town) {
    await this._q(this.db.from('outreach_towns').delete().eq('town', town));
  }

  async listExcluded() {
    return this._q(this.db.from('outreach_excluded').select('name_key,name,reason').limit(20000));
  }

  async upsertExcluded(rows) {
    if (!rows.length) return;
    await this._q(this.db.from('outreach_excluded').upsert(rows, { onConflict: 'name_key', ignoreDuplicates: true }));
  }
}

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

class MemoryStore {
  constructor() {
    this.settings = {};
    this.prospects = [];
    this.messages = [];
    this.events = [];
    this.towns = [];
    this.excluded = [];
  }
  async getSettings() { return mergeSettings(this.settings); }
  async getRawSettings() { return { ...this.settings }; }
  async saveSettings(d) { this.settings = { ...d }; }
  async listProspects({ statuses, limit = 1000, order = 'updated_at', ascending = false, maxAttempts } = {}) {
    let rows = this.prospects.filter(p => (!statuses || statuses.includes(p.status)) && (maxAttempts == null || (p.enrich_attempts || 0) < maxAttempts));
    rows = rows.slice().sort((a, b) => {
      const av = a[order] ?? -Infinity, bv = b[order] ?? -Infinity;
      return (av > bv ? 1 : av < bv ? -1 : 0) * (ascending ? 1 : -1);
    });
    return rows.slice(0, limit).map(r => ({ ...r }));
  }
  async getProspect(id) { const p = this.prospects.find(x => x.id === id); return p ? { ...p } : null; }
  async knownKeys() {
    return { names: new Set(this.prospects.map(p => p.name_key)), domains: new Set(this.prospects.map(p => p.domain).filter(Boolean)) };
  }
  async insertProspects(rows) {
    const out = [];
    for (const r of rows) {
      if (this.prospects.some(p => p.name_key === r.name_key && p.town === r.town)) continue;
      const now = new Date().toISOString();
      const row = { id: uid(), status: 'new', enrich_attempts: 0, facts: {}, fit_reasons: [], created_at: now, updated_at: now, ...r };
      this.prospects.push(row);
      out.push({ id: row.id, name: row.name });
    }
    return out;
  }
  async updateProspect(id, patch) {
    const p = this.prospects.find(x => x.id === id);
    if (p) Object.assign(p, patch, { updated_at: new Date().toISOString() });
  }
  async claim(id, from, to) {
    const p = this.prospects.find(x => x.id === id);
    if (!p || p.status !== from) return false;
    p.status = to;
    return true;
  }
  async countByStatus() {
    const out = {};
    for (const p of this.prospects) out[p.status] = (out[p.status] || 0) + 1;
    return out;
  }
  async listMessages(pid) { return this.messages.filter(m => m.prospect_id === pid).map(m => ({ ...m })); }
  async insertMessage(m) {
    if (m.message_id && this.messages.some(x => x.message_id === m.message_id)) throw new Error('duplicate message_id');
    const row = { id: uid(), created_at: new Date().toISOString(), ...m };
    this.messages.push(row);
    return { ...row };
  }
  async updateMessage(id, patch) { const m = this.messages.find(x => x.id === id); if (m) Object.assign(m, patch); }
  async messageExists(mid) { return this.messages.some(m => m.message_id === mid); }
  async sentMessageIndex() { return this.messages.filter(m => m.direction === 'out' && m.status === 'sent' && m.message_id); }
  async sentCountSince(date) { return this.messages.filter(m => m.direction === 'out' && m.status === 'sent' && new Date(m.sent_at) >= date).length; }
  async sentSeries(since) { return this.messages.filter(m => new Date(m.created_at) >= since && ['sent', 'received'].includes(m.status)); }
  async addEvent(prospect_id, kind, body) { this.events.unshift({ id: uid(), prospect_id, kind, body, created_at: new Date().toISOString() }); }
  async listEvents({ limit = 60, prospectId } = {}) { return this.events.filter(e => !prospectId || e.prospect_id === prospectId).slice(0, limit); }
  async listTowns() { return this.towns.slice().sort((a, b) => a.town.localeCompare(b.town)); }
  async upsertTown(row) {
    const t = this.towns.find(x => x.town === row.town);
    if (t) Object.assign(t, row); else this.towns.push({ enabled: true, last_sourced_at: null, last_found: null, ...row });
  }
  async deleteTown(town) { this.towns = this.towns.filter(t => t.town !== town); }
  async listExcluded() { return this.excluded.slice(); }
  async upsertExcluded(rows) { for (const r of rows) if (!this.excluded.some(x => x.name_key === r.name_key)) this.excluded.push(r); }
}

module.exports = { SupabaseStore, MemoryStore };
