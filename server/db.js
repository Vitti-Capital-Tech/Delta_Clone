/* Persistence layer. Two implementations behind one interface:
   - supabase: Postgres + Supabase Auth (production)
   - memory:   in-process, accepts any token (local testing: `npm run mock`) */
const iso = (ms) => new Date(ms).toISOString();

function rowFromAccount(a) {
  return { id: a.id, user_id: a.userId, name: a.name, balance: a.balance, initial: a.initial, realized: a.realized, fees: a.fees, funding: a.funding,
    lev: a.lev, positions: a.positions, orders: a.orders, created_at: iso(a.created), updated_at: iso(Date.now()) };
}
function accountFromRow(r) {
  return { id: r.id, userId: r.user_id, name: r.name, balance: r.balance, initial: r.initial, realized: r.realized, fees: r.fees, funding: r.funding,
    lev: r.lev || {}, positions: r.positions || {}, orders: r.orders || [], created: Date.parse(r.created_at), history: [], fills: [] };
}

function createSupabase(url, serviceKey) {
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  return {
    kind: 'supabase',
    async getOwner() { // single shared owner: no login, all accounts belong to one hidden user
      const email = 'owner@delta-demo.local';
      for (let page = 1; ; page++) {
        const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw new Error('owner lookup: ' + error.message);
        const u = data.users.find(x => x.email === email); if (u) return u.id;
        if (data.users.length < 200) break;
      }
      const pw = require('crypto').randomUUID() + require('crypto').randomUUID();
      const { data, error } = await sb.auth.admin.createUser({ email, password: pw, email_confirm: true });
      if (error) throw new Error('owner create: ' + error.message);
      return data.user.id;
    },
    async loadAll() {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const page = must(await sb.from('demo_accounts').select('*').range(from, from + 999), 'load accounts');
        rows.push(...page); if (page.length < 1000) break;
      }
      const accounts = rows.map(accountFromRow);
      await Promise.all(accounts.map(async (a) => {
        const f = must(await sb.from('demo_fills').select('*').eq('account_id', a.id).order('ts', { ascending: false }).limit(300), 'load fills');
        a.fills = f.map(x => ({ id: x.id, orderId: x.order_id, symbol: x.symbol, side: x.side, size: x.size, price: x.price, role: x.role, fee: x.fee, realized: x.realized, ts: Date.parse(x.ts) }));
        const h = must(await sb.from('demo_order_history').select('data').eq('account_id', a.id).order('ts', { ascending: false }).limit(300), 'load history');
        a.history = h.map(x => x.data);
      }));
      const meta = {};
      must(await sb.from('demo_meta').select('*'), 'load meta').forEach(m => meta[m.key] = m.value);
      const top = must(await sb.from('demo_order_history').select('id').order('id', { ascending: false }).limit(1), 'max order id');
      return { accounts, nextOrder: Math.max(+meta.next_order || 1, (top[0] ? +top[0].id : 0) + 1), fundingTs: +meta.funding_ts || 0 };
    },
    async saveAccount(a) { must(await sb.from('demo_accounts').upsert(rowFromAccount(a)), 'save account'); },
    async deleteAccount(id) { must(await sb.from('demo_accounts').delete().eq('id', id), 'delete account'); },
    async clearAccountData(id) {
      must(await sb.from('demo_fills').delete().eq('account_id', id), 'clear fills');
      must(await sb.from('demo_order_history').delete().eq('account_id', id), 'clear history');
    },
    async insertFill(a, f) {
      must(await sb.from('demo_fills').insert({ id: f.id, account_id: a.id, order_id: f.orderId || null, symbol: f.symbol, side: f.side, size: f.size, price: f.price, role: f.role, fee: f.fee, realized: f.realized, ts: iso(f.ts) }), 'insert fill');
    },
    async insertHistory(a, o) {
      must(await sb.from('demo_order_history').upsert({ id: o.id, account_id: a.id, data: o, ts: iso(o.ts) }), 'insert history');
    },
    async setMeta(key, value) { must(await sb.from('demo_meta').upsert({ key, value: String(value) }), 'set meta'); },
  };
}

function createMemory() {
  const accounts = new Map(), meta = {};
  return {
    kind: 'memory',
    async getOwner() { return 'local-owner'; },
    async loadAll() { return { accounts: [], nextOrder: 1, fundingTs: 0 }; },
    async saveAccount(a) { accounts.set(a.id, true); },
    async deleteAccount(id) { accounts.delete(id); },
    async clearAccountData() {}, async insertFill() {}, async insertHistory() {},
    async setMeta(k, v) { meta[k] = v; },
  };
}

module.exports = { createSupabase, createMemory };
