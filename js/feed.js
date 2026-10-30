/* Live market data straight from Delta Exchange India public endpoints (REST + WebSocket).
   Perpetual futures + call/put options. Runs in the browser and on the Node server. */
(function () {
  const REST = 'https://api.india.delta.exchange';
  const WSURL = 'wss://socket.india.delta.exchange';
  const handlers = {};
  const Feed = {
    products: {}, symbols: [], optionSymbols: [], tickers: {}, books: {}, trades: {}, status: 'connecting',
    on(e, f) { (handlers[e] = handlers[e] || []).push(f); },
    emit(e, ...a) { (handlers[e] || []).forEach(f => f(...a)); },
  };
  const isOpt = (s) => !!Feed.products[s] && Feed.products[s].kind !== 'perp';
  Feed.isOpt = isOpt;

  const decimals = (v) => {
    const s = String(+v);
    if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  };

  function parseProduct(p) {
    const ct = p.contract_type, kind = ct === 'call_options' ? 'call' : ct === 'put_options' ? 'put' : 'perp';
    const imr = +p.initial_margin;
    return {
      id: p.id, symbol: p.symbol, kind, strike: +p.strike_price || 0, expiry: p.settlement_time ? Date.parse(p.settlement_time) : 0,
      under: p.underlying_asset ? p.underlying_asset.symbol : p.contract_unit_currency, base: p.underlying_asset ? p.underlying_asset.symbol : p.contract_unit_currency,
      unit: p.contract_unit_currency, desc: p.description || p.symbol,
      cv: +p.contract_value, tick: +p.tick_size, dp: decimals(p.tick_size),
      maxLev: kind === 'perp' ? Math.max(1, Math.floor(100 / imr)) : 1, defLev: kind === 'perp' ? (Math.round(+p.default_leverage) || 10) : 1,
      imr: imr / 100, mmr: +p.maintenance_margin / 100,
      taker: +p.taker_commission_rate, maker: +p.maker_commission_rate,
      posLimit: p.position_size_limit || 1e9, liqPenalty: +p.liquidation_penalty_factor || 0.5,
    };
  }

  const num = (v) => (v === null || v === undefined || v === '' ? 0 : +v);
  function parseTicker(t) {
    const q = t.quotes || {}, g = t.greeks || null;
    const prev = Feed.tickers[t.symbol] || {};
    const close = +t.close;
    return {
      symbol: t.symbol, mark: +t.mark_price || close || prev.mark || 0, last: close || prev.last || 0, bid: +q.best_bid || 0,
      ask: +q.best_ask || 0, bidSize: num(q.bid_size), askSize: num(q.ask_size), open: +t.open, high: +t.high, low: +t.low,
      volUsd: +t.turnover_usd || 0, oiUsd: +t.oi_value_usd || 0, oi: num(t.oi_contracts), volume: num(t.size), funding: (+t.funding_rate || 0) / 100,
      spot: +t.spot_price || prev.spot || 0, band: t.price_band || null,
      iv: num(q.mark_iv), bidIv: num(q.bid_iv), askIv: num(q.ask_iv),
      greeks: g ? { delta: num(g.delta), gamma: num(g.gamma), theta: num(g.theta), vega: num(g.vega) } : null, ts: Date.now(),
    };
  }

  async function fetchProducts(types) {
    let after = null; const out = [];
    do {
      const r = await fetch(`${REST}/v2/products?contract_types=${types}&states=live&page_size=500${after ? '&after=' + encodeURIComponent(after) : ''}`).then(r => r.json());
      out.push(...(r.result || [])); after = r.meta && r.meta.after;
    } while (after && out.length < 5000);
    return out;
  }
  async function fetchTickers(types) {
    const r = await fetch(`${REST}/v2/tickers?contract_types=${types}`).then(r => r.json());
    for (const t of r.result || []) if (Feed.products[t.symbol]) Feed.tickers[t.symbol] = parseTicker(t);
  }
  function addProducts(list) {
    for (const raw of list) {
      if (raw.trading_status !== 'operational' || raw.is_quanto) continue;
      const p = parseProduct(raw);
      if (!(p.cv > 0)) continue;
      Feed.products[p.symbol] = p;
    }
    Feed.optionSymbols = Object.keys(Feed.products).filter(isOpt);
  }

  async function init() {
    const [perps, opts] = await Promise.all([fetchProducts('perpetual_futures'), fetchProducts('call_options,put_options').catch(() => [])]);
    addProducts(perps); addProducts(opts);
    Feed.symbols = Object.keys(Feed.products).filter(s => !isOpt(s));
    await Promise.all([fetchTickers('perpetual_futures'), fetchTickers('call_options,put_options').catch(() => {})]);
    Feed.symbols.sort((a, b) => ((Feed.tickers[b] || {}).volUsd || 0) - ((Feed.tickers[a] || {}).volUsd || 0));
    connect();
    setInterval(async () => { // new expiries list daily; refresh option marks as a fallback to the socket
      try { addProducts(await fetchProducts('call_options,put_options')); await fetchTickers('call_options,put_options'); Feed.emit('products'); } catch (_) {}
    }, 120000);
  }

  /* ---- options helpers ---- */
  Feed.expiries = (under) => [...new Set(Feed.optionSymbols.map(s => Feed.products[s]).filter(p => p.under === under && p.expiry > Date.now()).map(p => p.expiry))].sort((a, b) => a - b);
  Feed.chain = (under, expiry) => {
    const rows = {};
    for (const s of Feed.optionSymbols) {
      const p = Feed.products[s]; if (p.under !== under || p.expiry !== expiry) continue;
      (rows[p.strike] = rows[p.strike] || { strike: p.strike })[p.kind] = s;
    }
    return Object.values(rows).sort((a, b) => a.strike - b.strike);
  };
  Feed.spotOf = (under) => { const t = Feed.tickers[under + 'USD']; return t ? (t.spot || t.mark) : 0; };

  /* ---- websocket with per-channel symbol interest ---- */
  let ws, wd, retry = 0, interest = [], chainSyms = [];
  const want = { l2_orderbook: new Set(), all_trades: new Set(), 'v2/ticker': new Set() }; // v2/ticker: options only (perps are always on)
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const chan = (type, name, symbols) => { for (let i = 0; i < symbols.length; i += 150) send({ type, payload: { channels: [{ name, symbols: symbols.slice(i, i + 150) }] } }); };

  function sync() {
    const book = new Set(interest);
    const tick = new Set([...interest.filter(isOpt), ...chainSyms]);
    const target = { l2_orderbook: book, all_trades: book, 'v2/ticker': tick };
    for (const name of Object.keys(want)) {
      const add = [...target[name]].filter(s => !want[name].has(s));
      const del = [...want[name]].filter(s => !target[name].has(s));
      if (add.length) chan('subscribe', name, add);
      if (del.length) chan('unsubscribe', name, del);
      want[name] = new Set(target[name]);
    }
  }
  Feed.setInterest = (symbols) => { interest = symbols; sync(); };
  Feed.setChain = (symbols) => { chainSyms = symbols; sync(); };

  function connect() {
    ws = new WebSocket(WSURL);
    ws.onopen = () => {
      retry = 0; Feed.status = 'live'; Feed.emit('status');
      send({ type: 'enable_heartbeat' });
      chan('subscribe', 'v2/ticker', Feed.symbols);
      for (const name of Object.keys(want)) if (want[name].size) chan('subscribe', name, [...want[name]]);
    };
    ws.onmessage = (e) => { arm(); handle(JSON.parse(e.data)); };
    ws.onclose = () => { Feed.status = 'reconnecting'; Feed.emit('status'); clearTimeout(wd); setTimeout(connect, Math.min(5000, 500 * ++retry)); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
    arm();
  }
  function arm() { clearTimeout(wd); wd = setTimeout(() => { try { ws.close(); } catch (_) {} }, 20000); }

  function handle(m) {
    switch (m.type) {
      case 'v2/ticker': {
        if (!Feed.products[m.symbol]) return;
        Feed.tickers[m.symbol] = parseTicker(m);
        Feed.emit('ticker', m.symbol);
        break;
      }
      case 'l2_orderbook': {
        const side = (a, desc) => a.map(l => ({ p: +l.limit_price, s: +l.size, d: +l.depth })).sort((x, y) => desc ? y.p - x.p : x.p - y.p);
        Feed.books[m.symbol] = { bids: side(m.buy || [], true), asks: side(m.sell || [], false), ts: Date.now() };
        const t = Feed.tickers[m.symbol];
        const b = Feed.books[m.symbol];
        if (t) { t.bid = b.bids[0] ? b.bids[0].p : 0; t.ask = b.asks[0] ? b.asks[0].p : 0; }
        Feed.emit('book', m.symbol);
        break;
      }
      case 'all_trades_snapshot':
        Feed.trades[m.symbol] = (m.trades || []).slice(0, 60).map(parseTrade);
        Feed.emit('trades', m.symbol);
        break;
      case 'all_trades': {
        const tr = parseTrade(m);
        const arr = Feed.trades[m.symbol] || (Feed.trades[m.symbol] = []);
        arr.unshift(tr); if (arr.length > 60) arr.pop();
        const t = Feed.tickers[m.symbol]; if (t) t.last = tr.price;
        Feed.emit('trade', m.symbol, tr);
        break;
      }
    }
  }
  // Delta sends microsecond timestamps; `ts` is unix seconds
  const parseTrade = (t) => ({ price: +t.price, size: +t.size, side: t.buyer_role === 'taker' ? 'buy' : 'sell', ts: Math.floor(t.timestamp / 1e6) });

  /* ---- candles ---- */
  const RES = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800 };
  Feed.RES = RES;
  Feed.candles = async function (symbol, res, endSec) {
    const end = endSec || Math.floor(Date.now() / 1000), start = end - RES[res] * 500;
    const r = await fetch(`${REST}/v2/history/candles?symbol=${symbol}&resolution=${res}&start=${start}&end=${end}`).then(r => r.json());
    return (r.result || []).map(c => ({ time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume })).sort((a, b) => a.time - b.time);
  };

  Feed.init = init;
  (typeof window !== 'undefined' ? window : globalThis).Feed = Feed;
})();
