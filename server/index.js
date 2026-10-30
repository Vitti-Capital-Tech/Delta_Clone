/* Delta demo backend: authoritative trading engine + Supabase persistence + WebSocket API.
   Run:  npm start            (Supabase, needs .env)
         npm run mock         (in-memory DB, no login – local testing only) */
require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createSupabase, createMemory } = require('./db');

require('../js/feed.js');   // sets globalThis.Feed
require('../js/engine.js'); // sets globalThis.Engine (uses Feed)

const root = path.join(__dirname, '..');
const mock = process.argv.includes('--mock') || process.env.MOCK_DB === '1';
const PORT = +process.env.PORT || 5173;
const MAX_ACCOUNTS = 10;

let db;
if (mock) { db = createMemory(); console.log('[db] MOCK in-memory database – nothing is persisted, any login accepted'); }
else {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env (see .env.example). For a quick local test run: npm run mock');
    process.exit(1);
  }
  db = createSupabase(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

/* ---------- persistence plumbing ---------- */
let queue = Promise.resolve();
const enqueue = (fn) => { queue = queue.then(fn).catch(e => console.error('[db]', e.message)); return queue; };
Engine.onFill = (a, f) => enqueue(() => db.insertFill(a, f));
Engine.onArchive = (a, o) => { const copy = JSON.parse(JSON.stringify(o)); enqueue(() => db.insertHistory(a, copy)); };

const lastSaved = new Map();
let lastMeta = '';
setInterval(() => {
  const S = Engine.state;
  for (const a of S.accounts) {
    const key = JSON.stringify([a.name, a.balance, a.realized, a.fees, a.funding, a.lev, a.positions, a.orders]);
    if (lastSaved.get(a.id) !== key) { lastSaved.set(a.id, key); enqueue(() => db.saveAccount(a)); }
  }
  const m = S.nextOrder + ':' + S.fundingTs;
  if (m !== lastMeta) { lastMeta = m; enqueue(async () => { await db.setMeta('next_order', S.nextOrder); await db.setMeta('funding_ts', S.fundingTs); }); }
}, 300);

/* ---------- market data interest (books/trades only for symbols that matter) ---------- */
const recent = new Map();
function refreshInterest() {
  const set = new Set(), now = Date.now();
  for (const [s, t] of recent) { if (now - t < 600000) set.add(s); else recent.delete(s); }
  for (const a of Engine.state.accounts) { Object.keys(a.positions).forEach(s => set.add(s)); a.orders.forEach(o => set.add(o.symbol)); }
  Feed.setInterest([...set]);
}
async function ensureBook(sym) {
  recent.set(sym, Date.now());
  if (Feed.books[sym]) return;
  refreshInterest();
  for (let i = 0; i < 40 && !Feed.books[sym]; i++) await new Promise(r => setTimeout(r, 25));
}
setInterval(refreshInterest, 15000);

/* ---------- client sessions ---------- */
const sockets = new Map(); // userId -> Set<ws>
const lastSent = new Map();
const mine = (uid) => Engine.state.accounts.filter(a => a.userId === uid);
const snap = (a) => ({ id: a.id, name: a.name, balance: a.balance, initial: a.initial, created: a.created, positions: a.positions, orders: a.orders, lev: a.lev,
  realized: a.realized, fees: a.fees, funding: a.funding, history: a.history.slice(0, 100), fills: a.fills.slice(0, 100) });
const sendTo = (uid, msg) => { const s = sockets.get(uid); if (s) { const j = JSON.stringify(msg); s.forEach(w => w.readyState === 1 && w.send(j)); } };
function pushNow(uid, force) {
  if (!sockets.has(uid)) return;
  const j = JSON.stringify({ t: 'state', accounts: mine(uid).map(snap), fundingTs: Engine.state.fundingTs });
  if (!force && lastSent.get(uid) === j) return;
  lastSent.set(uid, j); sockets.get(uid).forEach(w => w.readyState === 1 && w.send(j));
}
let pushT = null;
function schedulePush() { if (pushT) return; pushT = setTimeout(() => { pushT = null; for (const uid of sockets.keys()) pushNow(uid); }, 40); }

Engine.onChange((kind, p) => {
  if (kind === 'fill' && p) {
    sendTo(p.acct.userId, { t: 'fill', acct: { id: p.acct.id, name: p.acct.name }, order: { side: p.order.side, symbol: p.order.symbol }, qty: p.qty, px: p.px, role: p.role });
    return;
  }
  if (kind === 'toast') {
    const a = Engine.state.accounts.find(x => x.id === p.acctId);
    if (a) sendTo(a.userId, { t: 'toast', type: p.type, msg: p.msg });
    return;
  }
  schedulePush();
});

/* ---------- request handlers ---------- */
const TYPES = ['limit', 'market', 'stop_limit', 'stop_market'];
function cleanOrder(o) {
  if (!o || !Feed.products[o.symbol]) throw new Error('Unknown market');
  if (!['buy', 'sell'].includes(o.side)) throw new Error('Invalid side');
  if (!TYPES.includes(o.type)) throw new Error('Invalid order type');
  return { symbol: o.symbol, side: o.side, type: o.type, size: +o.size, price: +o.price || 0, stop: +o.stop || 0, trigger: o.trigger === 'last' ? 'last' : 'mark',
    reduceOnly: !!o.reduceOnly, postOnly: !!o.postOnly, tp: +o.tp || null, sl: +o.sl || null };
}
function own(uid, id) { const a = Engine.state.accounts.find(x => x.id === id && x.userId === uid); if (!a) throw new Error('Account not found'); return a; }
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? Math.min(+v, 1e9) : d);

const OPS = {
  async createAccount(uid, m) {
    if (mine(uid).length >= MAX_ACCOUNTS) return { ok: false, error: `Maximum ${MAX_ACCOUNTS} demo accounts` };
    const a = Engine.createAccount(String(m.name || '').slice(0, 40), num(m.balance, 10000), uid);
    lastSaved.set(a.id, null); await enqueue(() => db.saveAccount(a));
    return { ok: true, id: a.id };
  },
  async renameAccount(uid, m) { const a = own(uid, m.id); Engine.renameAccount(a.id, String(m.name || '').slice(0, 40)); return { ok: true }; },
  async deposit(uid, m) { const a = own(uid, m.id); Engine.deposit(a.id, num(m.amt, 0)); return { ok: true }; },
  async resetAccount(uid, m) {
    const a = own(uid, m.id); await enqueue(() => db.clearAccountData(a.id));
    Engine.resetAccount(a.id, num(m.balance, a.initial)); return { ok: true };
  },
  async deleteAccount(uid, m) {
    const a = own(uid, m.id);
    if (mine(uid).length < 2) return { ok: false, error: 'Keep at least one account' };
    Engine.state.accounts = Engine.state.accounts.filter(x => x.id !== a.id); lastSaved.delete(a.id);
    enqueue(() => db.deleteAccount(a.id)); Engine.emit('accounts'); return { ok: true };
  },
  async setLeverage(uid, m) { const a = own(uid, m.acct); await ensureBook(String(m.symbol)); return Engine.setLeverage(a, String(m.symbol), +m.lev); },
  async place(uid, m) {
    const a = own(uid, m.acct), o = cleanOrder(m.order);
    await ensureBook(o.symbol);
    const r = Engine.place(a, o);
    return r.ok ? { ok: true, order: r.order } : r;
  },
  async cancel(uid, m) { Engine.cancel(own(uid, m.acct), +m.id); return { ok: true }; },
  async cancelAll(uid, m) { Engine.cancelAll(own(uid, m.acct), m.symbol || undefined); return { ok: true }; },
  async closePosition(uid, m) { const a = own(uid, m.acct); await ensureBook(String(m.symbol)); return Engine.closePosition(a, String(m.symbol), m.type === 'limit' ? 'limit' : 'market', +m.price || undefined); },
  async closeAll(uid, m) { const a = own(uid, m.acct); for (const s of Object.keys(a.positions)) { await ensureBook(s); Engine.closePosition(a, s, 'market'); } return { ok: true }; },
  async setTpSl(uid, m) { return Engine.setTpSl(own(uid, m.acct), String(m.symbol), +m.tp || null, +m.sl || null); },
};

/* ---------- http + websocket ---------- */
const crypto = require('crypto');
const PASS = process.env.APP_PASSWORD || '';
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const same = (pw) => crypto.timingSafeEqual(sha(pw), sha(PASS));
// Password may come as HTTP Basic (same-origin browser prompt) or as ?key= (UI hosted on another domain, e.g. Vercel). Skipped when APP_PASSWORD is unset.
function authed(header, key) {
  if (!PASS) return true;
  if (key && same(key)) return true;
  if (!header || !header.startsWith('Basic ')) return false;
  return same(Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':'));
}
if (!PASS) console.warn('[security] APP_PASSWORD is not set: anyone who can reach this server can trade. Set it before deploying.');
const app = express();
app.disable('x-powered-by');
app.get('/auth-check', (req, res) => { // lets a cross-origin UI test its password; CORS-open on purpose, reveals nothing else
  res.set('Access-Control-Allow-Origin', '*');
  authed(req.headers.authorization, req.query.key) ? res.json({ ok: true }) : res.status(401).json({ ok: false });
});
app.use((req, res, next) => {
  if (req.path === '/health' || authed(req.headers.authorization, req.query.key)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Delta Demo"').status(401).send('Authentication required');
});
app.get('/health', (_req, res) => res.json({ ok: true, feed: Feed.status, accounts: Engine.state.accounts.length }));
app.use('/js', express.static(path.join(root, 'js')));
app.use('/css', express.static(path.join(root, 'css')));
app.use('/assets', express.static(path.join(root, 'assets')));
app.get('/', (_req, res) => res.sendFile(path.join(root, 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024, verifyClient: (info) => authed(info.req.headers.authorization, new URL(info.req.url, 'http://x').searchParams.get('key')) });

let OWNER = null; // no login: every browser is the same single user
wss.on('connection', (ws) => {
  const ready = (async () => {
    const user = { id: OWNER };
    ws.user = user;
    if (!mine(user.id).length) await OPS.createAccount(user.id, { name: 'Demo Account 1', balance: 10000 });
    if (!sockets.has(user.id)) sockets.set(user.id, new Set());
    sockets.get(user.id).add(ws);
    pushNow(user.id, true);
  })();
  ws.on('message', async (raw) => {
    await ready; if (!ws.user) return;
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    let res;
    try {
      if (m.op === 'ping') res = { ok: true };
      else if (OPS[m.op]) res = await OPS[m.op](ws.user.id, m);
      else res = { ok: false, error: 'Unknown operation' };
    } catch (e) { res = { ok: false, error: e.message }; }
    pushNow(ws.user.id);
    ws.send(JSON.stringify({ ...res, t: 'res', rid: m.rid }));
  });
  ws.on('close', () => { if (ws.user) { const s = sockets.get(ws.user.id); if (s) { s.delete(ws); if (!s.size) { sockets.delete(ws.user.id); lastSent.delete(ws.user.id); } } } });
  ws.on('error', () => {});
});

(async () => {
  await Feed.init();
  OWNER = await db.getOwner();
  const st = await db.loadAll();
  Engine.setState({ accounts: st.accounts, activeId: null, nextOrder: st.nextOrder, fundingTs: st.fundingTs || Engine.state.fundingTs });
  st.accounts.forEach(a => lastSaved.set(a.id, JSON.stringify([a.name, a.balance, a.realized, a.fees, a.funding, a.lev, a.positions, a.orders])));
  refreshInterest();
  server.listen(PORT, () => console.log(`[server] http://localhost:${PORT}  accounts loaded: ${st.accounts.length}  markets: ${Feed.symbols.length}`));
})().catch(e => { console.error('Startup failed:', e); process.exit(1); });
process.on('unhandledRejection', e => console.error('[unhandled]', e));
