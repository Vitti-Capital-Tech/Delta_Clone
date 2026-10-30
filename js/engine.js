/* Local paper-trading engine: multiple demo accounts, isolated-margin linear perpetuals,
   book-walking market fills, maker/taker fees + GST, stops, TP/SL, liquidation, funding. */
(function () {
  /* Runs on the Node server (authoritative, simulate = true) and, as a read-only mirror of
     server state with the shared maths helpers, in the browser (simulate = false). */
  const G = typeof window !== 'undefined' ? window : globalThis;
  const Feed = G.Feed;
  const GST = 1.18;
  const handlers = [];
  const uid = () => (G.crypto && G.crypto.randomUUID ? G.crypto.randomUUID() : Math.random().toString(36).slice(2, 12));

  function newAccount(name, balance, userId) {
    return { id: uid(), userId, name, balance, initial: balance, created: Date.now(), positions: {}, orders: [], history: [], fills: [], lev: {}, realized: 0, fees: 0, funding: 0 };
  }

  let S = { accounts: [], activeId: null, nextOrder: 1, fundingTs: lastFundingSlot() };
  function changed(kind, payload) { handlers.forEach(h => h(kind, payload)); }

  const prod = (s) => Feed.products[s];
  const tk = (s) => Feed.tickers[s];
  const mark = (s) => (tk(s) && tk(s).mark) || 0;
  const last = (s) => (tk(s) && tk(s).last) || 0;
  const roundTick = (s, v) => { const p = prod(s); return Math.round(v / p.tick) * p.tick; };
  const levOf = (a, s) => prod(s).kind !== 'perp' ? 1 : Math.min(a.lev[s] || prod(s).defLev, prod(s).maxLev);
  const spotOf = (s) => { const t = tk(s); return (t && t.spot) || Feed.spotOf(prod(s).under) || 0; };
  /* margin locked per contract. Perps: notional/leverage. Long options: premium paid. Short options: ~exchange-style
     max(15% spot - OTM amount, 10% spot) of the underlying notional. */
  function marginUnit(s, side, px, lev) {
    const p = prod(s);
    if (p.kind === 'perp') return p.cv * px / lev;
    if (side === 'buy') return p.cv * px;
    const S0 = spotOf(s) || px, otm = p.kind === 'call' ? Math.max(p.strike - S0, 0) : Math.max(S0 - p.strike, 0);
    return p.cv * Math.max(0.15 * S0 - otm, 0.10 * S0);
  }
  /* fee per contract incl. GST. Options: rate x underlying notional, capped at 12.5% of the premium. */
  function feeUnit(s, px, role) {
    const p = prod(s), rate = role === 'maker' ? p.maker : p.taker;
    if (p.kind === 'perp') return p.cv * px * rate * GST;
    return Math.min(rate * (spotOf(s) || px) * p.cv, 0.125 * px * p.cv) * GST;
  }

  const Engine = {
    onChange(h) { handlers.push(h); },
    get state() { return S; },
    setState(s) { S = s; },
    simulate: true, // false in the browser: state is mirrored from the server
    emit: changed,
    onFill: null, onArchive: null, // persistence hooks used by the server
    get active() { return S.accounts.find(a => a.id === S.activeId) || S.accounts[0]; },
    levOf, prod, newAccount, marginUnit, feeUnit, spotOf,

    /* ---------- accounts ---------- */
    createAccount(name, balance, userId) {
      const n = S.accounts.filter(a => a.userId === userId).length + 1;
      const a = newAccount(name || `Demo Account ${n}`, Math.max(1, +balance || 10000), userId);
      S.accounts.push(a); S.activeId = a.id; changed('accounts'); return a;
    },
    switchAccount(id) { if (S.accounts.some(a => a.id === id)) { S.activeId = id; changed('accounts'); } },
    renameAccount(id, name) { const a = S.accounts.find(x => x.id === id); if (a && name) { a.name = name; changed('accounts'); } },
    resetAccount(id, balance) {
      const i = S.accounts.findIndex(a => a.id === id); if (i < 0) return;
      const old = S.accounts[i], b = Math.max(1, +balance || old.initial);
      const a = newAccount(old.name, b, old.userId); a.id = old.id; S.accounts[i] = a; changed('accounts');
    },
    deleteAccount(id) {
      if (S.accounts.length < 2) return false;
      S.accounts = S.accounts.filter(a => a.id !== id);
      if (S.activeId === id) S.activeId = S.accounts[0].id;
      changed('accounts'); return true;
    },
    deposit(id, amt) { const a = S.accounts.find(x => x.id === id); if (a) { a.balance += +amt; a.initial += +amt; changed('accounts'); } },

    /* ---------- account maths ---------- */
    upnl(pos, s) { return pos.size === 0 ? 0 : ((mark(s) || pos.entry) - pos.entry) * pos.size * prod(s).cv; },
    orderMargin(a, o) {
      if (o.reduceOnly || o.status === 'filled') return 0;
      const p = prod(o.symbol), rem = o.size - o.filled;
      const px = o.price || o.stop || last(o.symbol);
      const pos = a.positions[o.symbol];
      let open = rem;
      if (pos && Math.sign(pos.size) !== (o.side === 'buy' ? 1 : -1)) open = Math.max(0, rem - Math.abs(pos.size));
      return open * (marginUnit(o.symbol, o.side, px, levOf(a, o.symbol)) + feeUnit(o.symbol, px, 'taker'));
    },
    summary(a) {
      let upnl = 0, posMargin = 0, ordMargin = 0;
      for (const s in a.positions) { upnl += Engine.upnl(a.positions[s], s); posMargin += a.positions[s].margin; }
      for (const o of a.orders) ordMargin += Engine.orderMargin(a, o);
      return { balance: a.balance, upnl, equity: a.balance + upnl, posMargin, ordMargin, available: a.balance - posMargin - ordMargin };
    },
    liqPrice(pos, s) {
      if (!pos || !pos.size || prod(s).kind !== 'perp') return 0;
      const p = prod(s), q = Math.abs(pos.size) * p.cv;
      if (pos.size > 0) return Math.max(0, (pos.entry * q - pos.margin) / (q * (1 - p.mmr)));
      return (pos.entry * q + pos.margin) / (q * (1 + p.mmr));
    },
    setLeverage(a, s, lev) {
      if (prod(s).kind !== 'perp') return { ok: false, error: 'Leverage does not apply to options' };
      const p = prod(s); lev = Math.max(1, Math.min(p.maxLev, Math.round(lev)));
      const pos = a.positions[s];
      if (pos) {
        const need = Math.abs(pos.size) * p.cv * pos.entry / lev, diff = need - pos.margin;
        if (diff > Engine.summary(a).available) return { ok: false, error: 'Insufficient margin to apply this leverage' };
        if (need <= Math.abs(pos.size) * p.cv * pos.entry * p.mmr * 1.2) return { ok: false, error: 'Leverage too high for open position' };
        pos.margin = need; pos.lev = lev;
      }
      a.lev[s] = lev; changed('positions'); return { ok: true };
    },

    /* ---------- order entry ---------- */
    place(a, o) {
      const p = prod(o.symbol); if (!p) return { ok: false, error: 'Unknown market' };
      if (p.expiry && Date.now() >= p.expiry) return { ok: false, error: 'This contract has expired' };
      const t = tk(o.symbol) || {};
      o.size = Math.floor(+o.size);
      if (!(o.size >= 1)) return { ok: false, error: 'Size must be at least 1 contract' };
      if (o.size > p.posLimit) return { ok: false, error: `Max order size is ${p.posLimit} contracts` };
      const isLimit = o.type === 'limit' || o.type === 'stop_limit', isStop = o.type === 'stop_market' || o.type === 'stop_limit';
      if (isLimit) { o.price = roundTick(o.symbol, +o.price); if (!(o.price > 0)) return { ok: false, error: 'Enter a valid limit price' }; }
      if (isStop) { o.stop = roundTick(o.symbol, +o.stop); if (!(o.stop > 0)) return { ok: false, error: 'Enter a valid trigger price' }; }
      const pos = a.positions[o.symbol];
      if (o.reduceOnly) {
        if (!pos || Math.sign(pos.size) === (o.side === 'buy' ? 1 : -1)) return { ok: false, error: 'Reduce-only order would increase position' };
        o.size = Math.min(o.size, Math.abs(pos.size));
      }
      const ref = o.price || o.stop || (o.side === 'buy' ? t.ask : t.bid) || t.last;
      const book = Feed.books[o.symbol];
      const ex = book && book.bids[0] ? { bid: book.bids[0].p, ask: book.asks[0].p } : { bid: t.bid, ask: t.ask };
      if (o.postOnly && o.type === 'limit' && (o.side === 'buy' ? o.price >= ex.ask : o.price <= ex.bid)) return { ok: false, error: 'Post-only order would execute immediately' };
      if (!o.reduceOnly) {
        const probe = { ...o, filled: 0, price: o.price || ref, status: 'open' };
        const need = Engine.orderMargin(a, probe);
        if (need > Engine.summary(a).available + 1e-9) return { ok: false, error: 'Insufficient margin' };
      }
      const order = {
        id: S.nextOrder++, symbol: o.symbol, side: o.side, type: o.type, size: o.size, filled: 0, avg: 0,
        price: isLimit ? o.price : null, stop: isStop ? o.stop : null, trigger: o.trigger || 'mark',
        reduceOnly: !!o.reduceOnly, postOnly: !!o.postOnly, tp: o.tp || null, sl: o.sl || null,
        status: isStop ? 'untriggered' : 'open', ts: Date.now(),
      };
      if (isStop) {
        const cur = order.trigger === 'last' ? last(o.symbol) : mark(o.symbol);
        order.dir = order.stop > cur ? 'up' : 'down';
        a.orders.push(order);
        changed('orders'); return { ok: true, order };
      }
      a.orders.push(order);
      execute(a, order);
      if (order.type === 'market' && order.filled === 0) {
        const i = a.orders.indexOf(order); if (i >= 0) a.orders.splice(i, 1);
        return { ok: false, error: 'No liquidity available for a market order' };
      }
      changed('orders');
      return { ok: true, order };
    },
    cancel(a, id, reason) {
      const i = a.orders.findIndex(o => o.id === id); if (i < 0) return;
      const o = a.orders.splice(i, 1)[0];
      o.status = o.filled > 0 ? 'partially_filled_cancelled' : 'cancelled'; o.reason = reason || 'user';
      archive(a, o); changed('orders');
    },
    cancelAll(a, symbol) { [...a.orders].filter(o => !symbol || o.symbol === symbol).forEach(o => Engine.cancel(a, o.id)); },
    closePosition(a, s, type, price) {
      const pos = a.positions[s]; if (!pos) return { ok: false, error: 'No position' };
      return Engine.place(a, { symbol: s, side: pos.size > 0 ? 'sell' : 'buy', type: type || 'market', size: Math.abs(pos.size), price, reduceOnly: true });
    },
    closeAll(a) { Object.keys(a.positions).forEach(s => Engine.closePosition(a, s, 'market')); },
    setTpSl(a, s, tp, sl) {
      const pos = a.positions[s]; if (!pos) return { ok: false, error: 'No position' };
      const m = mark(s);
      if (tp && (pos.size > 0 ? tp <= m : tp >= m)) return { ok: false, error: 'Take profit on wrong side of mark price' };
      if (sl && (pos.size > 0 ? sl >= m : sl <= m)) return { ok: false, error: 'Stop loss on wrong side of mark price' };
      pos.tp = tp || null; pos.sl = sl || null; changed('positions'); return { ok: true };
    },
  };

  /* ---------- matching ---------- */
  function archive(a, o) {
    a.history.unshift(o); if (a.history.length > 300) a.history.pop();
    if (Engine.onArchive) Engine.onArchive(a, o);
  }

  function walk(sym, side, size, limit) {
    const b = Feed.books[sym], t = tk(sym) || {};
    const levels = b ? (side === 'buy' ? b.asks : b.bids) : [{ p: side === 'buy' ? t.ask : t.bid, s: 1e12 }];
    let rem = size, cost = 0, got = 0, lastP = 0;
    for (const l of levels) {
      if (!l.p) continue;
      if (limit != null && (side === 'buy' ? l.p > limit : l.p < limit)) break;
      const take = Math.min(rem, l.s); cost += take * l.p; got += take; rem -= take; lastP = l.p;
      if (rem <= 0) break;
    }
    if (rem > 0 && limit == null && got > 0) { cost += rem * lastP; got += rem; rem = 0; } // market order beyond visible depth
    if (got === 0 && limit == null) { const px = side === 'buy' ? t.ask : t.bid; if (px) { cost = size * px; got = size; } }
    return { qty: got, px: got ? cost / got : 0 };
  }

  function execute(a, o) {
    const rem = o.size - o.filled;
    if (o.type === 'market' || o.type === 'stop_market') {
      const w = walk(o.symbol, o.side, rem);
      return fillOrder(a, o, w.qty, w.px, 'taker');
    }
    const w = walk(o.symbol, o.side, rem, o.price);
    if (w.qty > 0) fillOrder(a, o, w.qty, w.px, 'taker');
  }

  function fillOrder(a, o, qty, px, role) {
    qty = Math.min(qty, o.size - o.filled);
    if (qty <= 0) return;
    const p = prod(o.symbol);
    const fee = qty * feeUnit(o.symbol, px, role);
    const before = a.positions[o.symbol] ? a.positions[o.symbol].size : 0;
    const realized = applyFill(a, o.symbol, o.side, qty, px, fee);
    o.avg = (o.avg * o.filled + px * qty) / (o.filled + qty);
    o.filled += qty;
    const rec = { id: uid(), orderId: o.id, symbol: o.symbol, side: o.side, size: qty, price: px, role, fee, realized, ts: Date.now() };
    a.fills.unshift(rec);
    if (a.fills.length > 300) a.fills.pop();
    if (Engine.onFill) Engine.onFill(a, rec);
    const pos = a.positions[o.symbol];
    if (pos && (o.tp || o.sl) && Math.abs(pos.size) > 0 && Math.sign(pos.size) === (o.side === 'buy' ? 1 : -1)) {
      if (o.tp) pos.tp = o.tp; if (o.sl) pos.sl = o.sl;
    }
    trimReduceOnly(a, o.symbol);
    if (o.filled >= o.size) {
      o.status = 'filled';
      const i = a.orders.indexOf(o); if (i >= 0) a.orders.splice(i, 1);
      archive(a, o);
    } else o.status = 'open';
    Engine.lastFill = { acct: a.id, symbol: o.symbol, side: o.side, qty, px, role };
    handlers.forEach(h => h('fill', { acct: a, order: o, qty, px, role, fee, realized, before }));
    changed('fill');
  }

  function applyFill(a, sym, side, qty, px, fee) {
    const p = prod(sym), q = side === 'buy' ? qty : -qty;
    let pos = a.positions[sym];
    if (!pos) pos = a.positions[sym] = { size: 0, entry: 0, margin: 0, lev: levOf(a, sym), tp: null, sl: null, opened: Date.now() };
    let realized = 0, remaining = q;
    if (pos.size !== 0 && Math.sign(pos.size) !== Math.sign(q)) {
      const closeQty = Math.min(Math.abs(pos.size), Math.abs(q));
      realized = (px - pos.entry) * Math.sign(pos.size) * closeQty * p.cv;
      pos.margin -= pos.margin * (closeQty / Math.abs(pos.size));
      pos.size += Math.sign(q) * closeQty;
      remaining = q - Math.sign(q) * closeQty;
      a.balance += realized; a.realized += realized;
    }
    if (remaining !== 0) {
      if (pos.size === 0) { pos.lev = levOf(a, sym); pos.entry = px; pos.opened = Date.now(); pos.tp = pos.sl = null; }
      const add = Math.abs(remaining), tot = Math.abs(pos.size) + add;
      pos.entry = (pos.entry * Math.abs(pos.size) + px * add) / tot;
      pos.margin += add * marginUnit(sym, remaining > 0 ? 'buy' : 'sell', px, pos.lev);
      pos.size += remaining;
    }
    a.balance -= fee; a.fees += fee;
    if (pos.size === 0) delete a.positions[sym];
    return realized - fee;
  }

  function trimReduceOnly(a, sym) {
    const pos = a.positions[sym], abs = pos ? Math.abs(pos.size) : 0;
    for (const o of [...a.orders]) {
      if (o.symbol !== sym || !o.reduceOnly) continue;
      const wrongSide = !pos || Math.sign(pos.size) === (o.side === 'buy' ? 1 : -1);
      if (wrongSide || abs === 0) Engine.cancel(a, o.id, 'position closed');
      else if (o.size - o.filled > abs) o.size = o.filled + abs;
    }
  }

  /* ---------- reacting to the market ---------- */
  function onMarket(sym, kind, tr) {
    if (!Engine.simulate) return;
    let dirty = false;
    for (const a of S.accounts) {
      for (const o of [...a.orders]) {
        if (o.symbol !== sym) continue;
        if (o.status === 'untriggered') {
          const ref = o.trigger === 'last' ? last(sym) : mark(sym);
          if (ref && (o.dir === 'up' ? ref >= o.stop : ref <= o.stop)) {
            o.status = 'open'; o.triggeredAt = Date.now();
            if (!o.reduceOnly && Engine.summary(a).available < 0) { Engine.cancel(a, o.id, 'insufficient margin'); }
            else execute(a, o);
            dirty = true;
          }
        } else if (o.status === 'open' && o.price) {
          const t = tk(sym), b = Feed.books[sym];
          const ask = b && b.asks[0] ? b.asks[0].p : t.ask, bid = b && b.bids[0] ? b.bids[0].p : t.bid;
          const rem = o.size - o.filled;
          if (o.side === 'buy') {
            if (ask && ask <= o.price) fillOrder(a, o, rem, o.price, 'maker');
            else if (kind === 'trade' && tr.price < o.price) fillOrder(a, o, rem, o.price, 'maker');
            else if (kind === 'trade' && tr.price === o.price) fillOrder(a, o, Math.min(rem, tr.size), o.price, 'maker');
          } else {
            if (bid && bid >= o.price) fillOrder(a, o, rem, o.price, 'maker');
            else if (kind === 'trade' && tr.price > o.price) fillOrder(a, o, rem, o.price, 'maker');
            else if (kind === 'trade' && tr.price === o.price) fillOrder(a, o, Math.min(rem, tr.size), o.price, 'maker');
          }
        }
      }
      const pos = a.positions[sym];
      if (pos && kind !== 'book') {
        const m = mark(sym), p = prod(sym);
        const equity = pos.margin + Engine.upnl(pos, sym);
        const thr = p.kind === 'perp' ? Math.abs(pos.size) * p.cv * m * p.mmr : pos.size < 0 ? pos.margin * 0.5 : -1e18; // long options can't be liquidated
        if (m && equity <= thr) { liquidate(a, sym); dirty = true; }
        else if (pos.sl && (pos.size > 0 ? m <= pos.sl : m >= pos.sl)) { pos.sl = pos.tp = null; Engine.closePosition(a, sym, 'market'); handlers.forEach(h => h('toast', { acctId: a.id, type: 'info', msg: `Stop loss triggered on ${sym}` })); dirty = true; }
        else if (pos.tp && (pos.size > 0 ? m >= pos.tp : m <= pos.tp)) { pos.sl = pos.tp = null; Engine.closePosition(a, sym, 'market'); handlers.forEach(h => h('toast', { acctId: a.id, type: 'success', msg: `Take profit hit on ${sym}` })); dirty = true; }
      }
    }
    if (dirty) changed('market');
  }

  function liquidate(a, sym) {
    const pos = a.positions[sym], p = prod(sym), m = mark(sym);
    const realized = (m - pos.entry) * pos.size * p.cv;
    const left = Math.max(0, pos.margin + realized);
    const penalty = Math.min(left, p.kind === 'perp' ? Math.abs(pos.size) * p.cv * m * p.mmr * p.liqPenalty : left * 0.1);
    a.balance += realized - penalty; a.realized += realized; a.fees += penalty;
    const rec = { id: uid(), orderId: 0, symbol: sym, side: pos.size > 0 ? 'sell' : 'buy', size: Math.abs(pos.size), price: m, role: 'liquidation', fee: penalty, realized: realized - penalty, ts: Date.now() };
    a.fills.unshift(rec);
    if (Engine.onFill) Engine.onFill(a, rec);
    delete a.positions[sym];
    for (const o of [...a.orders]) if (o.symbol === sym && o.reduceOnly) Engine.cancel(a, o.id, 'liquidated');
    handlers.forEach(h => h('toast', { acctId: a.id, type: 'error', msg: `${a.name}: ${sym} position liquidated at ${m}` }));
  }

  /* ---------- option expiry: cancel orders, cash-settle positions at the underlying spot ---------- */
  Engine.settleExpired = function (now = Date.now()) {
    if (!Engine.simulate) return;
    let dirty = false;
    for (const a of S.accounts) {
      for (const o of [...a.orders]) { const p = prod(o.symbol); if (p && p.expiry && now >= p.expiry) { Engine.cancel(a, o.id, 'expired'); dirty = true; } }
      for (const sym of Object.keys(a.positions)) {
        const p = prod(sym); if (!p || !p.expiry || now < p.expiry) continue;
        const pos = a.positions[sym], spot = Feed.spotOf(p.under) || pos.entry;
        const payoff = p.kind === 'call' ? Math.max(spot - p.strike, 0) : Math.max(p.strike - spot, 0);
        const realized = (payoff - pos.entry) * pos.size * p.cv;
        a.balance += realized; a.realized += realized;
        const rec = { id: uid(), orderId: 0, symbol: sym, side: pos.size > 0 ? 'sell' : 'buy', size: Math.abs(pos.size), price: payoff, role: 'settlement', fee: 0, realized, ts: now };
        a.fills.unshift(rec); if (Engine.onFill) Engine.onFill(a, rec);
        delete a.positions[sym];
        handlers.forEach(h => h('toast', { acctId: a.id, type: realized >= 0 ? 'success' : 'info', msg: `${sym} expired. Settled at ${payoff.toFixed(p.dp)}, PnL ${realized.toFixed(2)} USD` }));
        dirty = true;
      }
    }
    if (dirty) changed('expiry');
  };
  setInterval(() => Engine.settleExpired(), 1000);

  Feed.on('book', s => onMarket(s, 'book'));
  Feed.on('trade', (s, tr) => onMarket(s, 'trade', tr));
  Feed.on('ticker', s => onMarket(s, 'ticker'));

  /* ---------- funding (00:00 / 08:00 / 16:00 UTC) ---------- */
  function lastFundingSlot(now = Date.now()) { const d = new Date(now); d.setUTCMinutes(0, 0, 0); d.setUTCHours(Math.floor(d.getUTCHours() / 8) * 8); return d.getTime(); }
  Engine.nextFunding = () => lastFundingSlot() + 8 * 3600e3;
  setInterval(() => {
    if (!Engine.simulate) return;
    const slot = lastFundingSlot();
    if (slot <= S.fundingTs) return;
    S.fundingTs = slot;
    for (const a of S.accounts) for (const s in a.positions) {
      const pos = a.positions[s], t = tk(s); if (!t) continue;
      const pay = pos.size * prod(s).cv * t.mark * t.funding;
      a.balance -= pay; a.funding -= pay;
    }
    changed('funding');
  }, 1000);

  G.Engine = Engine;
})();
