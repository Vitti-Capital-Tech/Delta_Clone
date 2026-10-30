/* Browser side of the backend: Supabase login, one authenticated WebSocket, and a thin
   Engine facade. Orders are executed on the server; the UI just mirrors its state. */
(function () {
  const Client = { user: null };
  Engine.simulate = false;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  Engine.state.activeId = lsGet('dx_active');

  let ws = null, rid = 1, retry = 0, firstState = null, closing = false;
  const pending = new Map();

  /* ---------- websocket ---------- */
  function connect() {
    return new Promise(async (resolve) => {
      firstState = resolve;
      ws = new WebSocket(`${wsBase}/ws${key ? '?key=' + encodeURIComponent(key) : ''}`);
      ws.onmessage = (e) => onMsg(JSON.parse(e.data));
      ws.onclose = async (e) => {
        pending.forEach(p => p.reject(new Error('Disconnected'))); pending.clear();
        if (closing) return;
        Client.connected = false; Engine.emit('conn');
        setTimeout(() => connect().then(() => {}), Math.min(5000, 400 * ++retry));
      };
      ws.onopen = () => { retry = 0; Client.connected = true; Engine.emit('conn'); };
    });
  }

  function onMsg(m) {
    if (m.t === 'state') {
      const S = Engine.state;
      S.accounts = m.accounts; S.fundingTs = m.fundingTs;
      if (!S.accounts.some(a => a.id === S.activeId)) { S.activeId = S.accounts[0] && S.accounts[0].id; }
      Engine.emit('state');
      if (firstState) { const f = firstState; firstState = null; f(); }
    } else if (m.t === 'res') {
      const p = pending.get(m.rid); if (p) { pending.delete(m.rid); p.resolve(m); }
    } else if (m.t === 'fill') {
      Engine.emit('fill', { acct: m.acct, order: m.order, qty: m.qty, px: m.px, role: m.role });
    } else if (m.t === 'toast') {
      Engine.emit('toast', { type: m.type, msg: m.msg });
    }
  }

  function rpc(op, args) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return resolve({ ok: false, error: 'Not connected to server' });
      const id = rid++, t = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'Server timeout' }); }, 15000);
      pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, reject: () => { clearTimeout(t); resolve({ ok: false, error: 'Disconnected' }); } });
      ws.send(JSON.stringify({ rid: id, op, ...args }));
    });
  }

  /* ---------- Engine facade (same names the UI already uses, now async) ---------- */
  Object.assign(Engine, {
    place: (a, order) => rpc('place', { acct: a.id, order }),
    cancel: (a, id) => rpc('cancel', { acct: a.id, id }),
    cancelAll: (a, symbol) => rpc('cancelAll', { acct: a.id, symbol }),
    closePosition: (a, symbol, type, price) => rpc('closePosition', { acct: a.id, symbol, type, price }),
    closeAll: (a) => rpc('closeAll', { acct: a.id }),
    setTpSl: (a, symbol, tp, sl) => rpc('setTpSl', { acct: a.id, symbol, tp, sl }),
    setLeverage: (a, symbol, lev) => rpc('setLeverage', { acct: a.id, symbol, lev }),
    async createAccount(name, balance) { const r = await rpc('createAccount', { name, balance }); if (r.ok) Engine.switchAccount(r.id); return r; },
    renameAccount: (id, name) => rpc('renameAccount', { id, name }),
    resetAccount: (id, balance) => rpc('resetAccount', { id, balance }),
    deleteAccount: (id) => rpc('deleteAccount', { id }),
    deposit: (id, amt) => rpc('deposit', { id, amt }),
    switchAccount(id) {
      if (!Engine.state.accounts.some(a => a.id === id)) return;
      Engine.state.activeId = id; try { localStorage.setItem('dx_active', id); } catch (_) {}
      Engine.emit('accounts');
    },
  });

  /* The UI can be hosted elsewhere (Vercel): APP_CONFIG.backend = 'https://your-backend-address'. Empty = same site as the page. */
  const BACKEND = ((window.APP_CONFIG || {}).backend || '').replace(/\/+$/, '');
  const httpBase = BACKEND || '';
  const wsBase = BACKEND ? BACKEND.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  let key = lsGet('dx_key') || '';
  async function checkKey(k) {
    try { const r = await fetch(`${httpBase}/auth-check?key=${encodeURIComponent(k)}`); return r.ok; } catch (_) { return false; }
  }
  function passwordScreen(msg) {
    return new Promise((resolve) => {
      const w = document.createElement('div'); w.className = 'modal';
      w.innerHTML = `<div class="mbox" style="width:min(360px,92vw)"><h3>Enter password</h3><div class="fld"><div class="inp"><input id="pwIn" type="password" autocomplete="current-password" autofocus></div></div>
        <div id="pwMsg" class="mut" style="margin-top:10px;min-height:18px;color:var(--sell)">${msg || ''}</div><div class="mrow" style="justify-content:flex-end"><button class="btn pri" id="pwOk">Enter</button></div></div>`;
      document.body.appendChild(w); const i = w.querySelector('#pwIn'); i.focus();
      const go = () => { const v = i.value; w.remove(); resolve(v); };
      w.querySelector('#pwOk').onclick = go; i.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    });
  }
  async function ensureKey() {
    let msg = '';
    for (;;) {
      if (await checkKey(key)) { try { localStorage.setItem('dx_key', key); } catch (_) {} return; }
      if (!BACKEND && !key) { return; } // same-origin: the browser's own Basic-auth prompt already guards the page
      key = await passwordScreen(msg); msg = 'Wrong password, or the server is unreachable';
    }
  }

  Client.start = async function () {
    await ensureKey();
    await connect();
  };
  window.Client = Client;
})();
