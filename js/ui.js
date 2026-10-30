(async function () {
  const $ = (s, e = document) => e.querySelector(s);
  const fmt = (n, d = 2) => Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '--';
  const compact = (n) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cls = (n) => n > 0 ? 'buy' : n < 0 ? 'sell' : '';
  const sgn = (n, d = 2) => (n > 0 ? '+' : '') + fmt(n, d);
  const z2 = (n) => String(n).padStart(2, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayLbl = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MON[d.getMonth()]}`; };
  const hhmm = (ms) => { const d = new Date(ms); return `${z2(d.getHours())}:${z2(d.getMinutes())}`; };
  const left = (ms) => { const s = Math.max(0, Math.floor((ms - Date.now()) / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${z2(s % 60)}s`; };
  const FAV = ['BTCUSD', 'ETHUSD', 'XAUTUSD'];

  const saved = (() => { try { return JSON.parse(localStorage.getItem('dx_ui2')) || {}; } catch (_) { return {}; } })();
  const ui = {
    view: saved.view || 'futures', perp: saved.perp || 'BTCUSD', opt: saved.opt || null, under: saved.under || 'BTC', expiry: null, optMode: 'chain', showAll: false,
    sym: null, res: saved.res || '5m', ctype: saved.ctype || 'candles', otype: 'limit', botTab: 'positions', bookTab: 'book',
    f: { size: '', price: '', stop: '', trigger: 'mark', reduce: false, post: false, tpOn: false, tp: '', sl: '' },
  };
  const saveUi = () => { try { localStorage.setItem('dx_ui2', JSON.stringify({ view: ui.view, perp: ui.perp, opt: ui.opt, under: ui.under, res: ui.res, ctype: ui.ctype })); } catch (_) {} };

  $('#symBtn').textContent = 'Loading markets…';
  try { await Promise.all([Feed.init(), Client.start()]); } catch (e) {
    document.body.insertAdjacentHTML('beforeend', `<div class="modal"><div class="mbox"><h3>Cannot start</h3>Check your internet connection and that the backend server is running, then reload.<br><span class="mut">${esc(e.message)}</span></div></div>`);
    return;
  }
  if (!Feed.products[ui.perp] || Feed.products[ui.perp].kind !== 'perp') ui.perp = 'BTCUSD';
  const P = () => Feed.products[ui.sym];
  const T = () => Feed.tickers[ui.sym] || {};
  const isOpt = () => P().kind !== 'perp';
  const unders = () => [...new Set(Feed.optionSymbols.map(s => Feed.products[s].under))].sort((a, b) => (a === 'BTC' ? -1 : b === 'BTC' ? 1 : a.localeCompare(b)));

  /* ================= chart ================= */
  const localTime = (t) => { const d = new Date(t * 1000); return `${dayLbl(t * 1000)} ${hhmm(t * 1000)}`; };
  const chart = LightweightCharts.createChart($('#chart'), {
    layout: { background: { color: '#14171b' }, textColor: '#8a929b', fontSize: 12 },
    grid: { vertLines: { color: '#1a1e23' }, horzLines: { color: '#1a1e23' } },
    rightPriceScale: { borderColor: '#23282e', scaleMargins: { top: 0.08, bottom: 0.22 } },
    timeScale: { borderColor: '#23282e', timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 9,
      tickMarkFormatter: (t, type) => (type <= 2 ? dayLbl(t * 1000) : hhmm(t * 1000)) },
    localization: { timeFormatter: localTime },
    crosshair: { mode: 0, vertLine: { color: '#4a525c', labelBackgroundColor: '#2a3038' }, horzLine: { color: '#4a525c', labelBackgroundColor: '#2a3038' } },
  });
  const candles = chart.addCandlestickSeries({ upColor: '#00b386', downColor: '#f6465d', borderVisible: false, wickUpColor: '#00b386', wickDownColor: '#f6465d' });
  const lineS = chart.addLineSeries({ color: '#3b82f6', lineWidth: 2, visible: false, lastValueVisible: true });
  const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'v', lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('v').applyOptions({ scaleMargins: { top: .82, bottom: 0 } });
  new ResizeObserver(() => { const el = $('#chart'); if (el.clientWidth) chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }); }).observe($('#chart'));
  const mainSeries = () => ui.ctype === 'line' ? lineS : candles;
  let allData = [], volBy = {}, lastCandle = null, loadTok = 0, lines = [], loadingMore = false, noMore = false, loadedKey = '';
  const volColor = (c) => c.close >= c.open ? '#00b38655' : '#f6465d55';

  function setAll(data) {
    allData = data; volBy = {}; data.forEach(c => volBy[c.time] = c.volume);
    candles.setData(data); lineS.setData(data.map(c => ({ time: c.time, value: c.close }))); vol.setData(data.map(c => ({ time: c.time, value: c.volume, color: volColor(c) })));
  }
  function showLegend(c) {
    const lg = $('#legend'), p = P();
    if (!c) { lg.innerHTML = `<b>${esc(ui.sym)}</b> <span class="mut">· ${ui.res} · no trades in this range</span>`; return; }
    const ch = c.open ? (c.close - c.open) / c.open * 100 : 0, k = cls(ch), d = p.dp;
    lg.innerHTML = `<b>${esc(ui.sym)}</b> <span class="mut">· ${ui.res}</span> <span>O <b class="${k}">${fmt(c.open, d)}</b> H <b class="${k}">${fmt(c.high, d)}</b> L <b class="${k}">${fmt(c.low, d)}</b> C <b class="${k}">${fmt(c.close, d)}</b> <b class="${k}">${sgn(ch)}%</b></span> <span class="mut">Vol <b>${compact(c.volume || 0)}</b></span>`;
  }
  chart.subscribeCrosshairMove((param) => {
    const d = param.time && param.seriesData && param.seriesData.get(candles);
    showLegend(d ? { ...d, volume: volBy[param.time] } : lastCandle);
  });

  async function loadCandles() {
    const tok = ++loadTok, p = P(); loadedKey = ui.sym + '|' + ui.res;
    const pf = { priceFormat: { type: 'price', precision: p.dp, minMove: p.tick } };
    candles.applyOptions(pf); lineS.applyOptions(pf);
    noMore = false; loadingMore = false;
    const data = await Feed.candles(ui.sym, ui.res).catch(() => []);
    if (tok !== loadTok) return;
    setAll(data); lastCandle = data[data.length - 1] || null;
    const n = data.length; if (n) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 110), to: n + 8 });
    showLegend(lastCandle); refreshLines();
  }
  async function loadMore() {
    if (loadingMore || noMore || !allData.length) return;
    loadingMore = true; const tok = loadTok, first = allData[0].time;
    const more = await Feed.candles(ui.sym, ui.res, first - 1).catch(() => []);
    loadingMore = false; if (tok !== loadTok) return;
    const fresh = more.filter(c => c.time < first);
    if (!fresh.length) { noMore = true; return; }
    const r = chart.timeScale().getVisibleLogicalRange();
    setAll([...fresh, ...allData]); lastCandle = allData[allData.length - 1];
    if (r) chart.timeScale().setVisibleLogicalRange({ from: r.from + fresh.length, to: r.to + fresh.length });
  }
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r && r.from < 15) loadMore(); });

  Feed.on('trade', (s, tr) => {
    if (s !== ui.sym) return;
    const step = Feed.RES[ui.res], b = Math.floor(tr.ts / step) * step;
    if (!lastCandle || b > lastCandle.time) { lastCandle = { time: b, open: tr.price, high: tr.price, low: tr.price, close: tr.price, volume: 0 }; allData.push(lastCandle); }
    else if (b < lastCandle.time) return;
    lastCandle.high = Math.max(lastCandle.high, tr.price); lastCandle.low = Math.min(lastCandle.low, tr.price);
    lastCandle.close = tr.price; lastCandle.volume += tr.size; volBy[b] = lastCandle.volume;
    candles.update(lastCandle); lineS.update({ time: b, value: tr.price });
    vol.update({ time: b, value: lastCandle.volume, color: volColor(lastCandle) });
  });

  function refreshLines() {
    lines.forEach(l => { try { candles.removePriceLine(l); } catch (_) {} try { lineS.removePriceLine(l); } catch (_) {} }); lines = [];
    const a = Engine.active; if (!a) return;
    const ms = mainSeries(), add = (price, color, title) => price && lines.push(ms.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
    const pos = a.positions[ui.sym];
    if (pos) {
      add(pos.entry, pos.size > 0 ? '#00b386' : '#f6465d', `${pos.size > 0 ? 'Long' : 'Short'} ${Math.abs(pos.size)}`);
      add(Engine.liqPrice(pos, ui.sym), '#e0a030', 'Liq'); add(pos.tp, '#00b386', 'TP'); add(pos.sl, '#f6465d', 'SL');
    }
    for (const o of a.orders) if (o.symbol === ui.sym) add(o.price || o.stop, '#7f8790', `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.size - o.filled}${o.stop ? ' stop' : ''}`);
  }

  function buildChartBar() {
    $('#resBar').innerHTML = Object.keys(Feed.RES).map(r => `<button data-r="${r}" class="${r === ui.res ? 'on' : ''}">${r}</button>`).join('');
    $('#chartOpts').innerHTML = `<button data-o="candles" class="${ui.ctype === 'candles' ? 'on' : ''}">Candles</button><button data-o="line" class="${ui.ctype === 'line' ? 'on' : ''}">Line</button><button data-o="fit">Fit</button>` +
      (ui.view === 'options' ? '<button data-o="chain" class="acc">← Option chain</button>' : '');
  }
  $('#resBar').onclick = (e) => { const r = e.target.dataset.r; if (!r) return; ui.res = r; saveUi(); buildChartBar(); loadCandles(); };
  $('#chartOpts').onclick = (e) => {
    const o = e.target.dataset.o; if (!o) return;
    if (o === 'candles' || o === 'line') { ui.ctype = o; candles.applyOptions({ visible: o === 'candles' }); lineS.applyOptions({ visible: o === 'line' }); saveUi(); buildChartBar(); refreshLines(); }
    if (o === 'fit') { const n = allData.length; if (n) chart.timeScale().setVisibleLogicalRange({ from: 0, to: n + 8 }); }
    if (o === 'chain') { ui.optMode = 'chain'; applyView(); }
  };

  /* ================= view switching ================= */
  function pickAtm() {
    const rows = Feed.chain(ui.under, ui.expiry), spot = Feed.spotOf(ui.under);
    if (!rows.length) return null;
    const r = rows.reduce((b, x) => Math.abs(x.strike - spot) < Math.abs(b.strike - spot) ? x : b, rows[0]);
    return r.call || r.put;
  }
  function ensureExpiry() {
    const ex = Feed.expiries(ui.under);
    if (!ui.expiry || !ex.includes(ui.expiry)) ui.expiry = ex[0] || null;
    return ex;
  }
  function setView(v) {
    ui.view = v; saveUi();
    if (v === 'futures') ui.sym = ui.perp;
    else {
      if (!unders().includes(ui.under)) ui.under = unders()[0];
      ensureExpiry();
      if (!ui.opt || !Feed.products[ui.opt] || Feed.products[ui.opt].under !== ui.under) ui.opt = pickAtm();
      ui.sym = ui.opt;
    }
    ui.f.price = ui.f.stop = ui.f.tp = ui.f.sl = ''; ui.f.size = '';
    applyView(); updateInterest(); renderOrderPanel(); dirty(true);
  }
  function applyView() {
    const opt = ui.view === 'options', chain = opt && ui.optMode === 'chain';
    [...$('#nav').children].forEach(a => a.classList.toggle('on', a.dataset.view === ui.view));
    $('#chips').classList.toggle('hidden', opt);
    $('#chain').classList.toggle('hidden', !chain);
    $('#chartWrap').classList.toggle('hidden', chain); $('#chartTools').classList.toggle('hidden', chain);
    buildChartBar(); renderSymBtn();
    if (chain) { renderChainBar(); renderChainTbl(true); }
    else if (ui.sym && loadedKey !== ui.sym + '|' + ui.res) loadCandles(); else refreshLines();
    if (!chain) Feed.setChain([]);
  }
  $('#nav').onclick = (e) => { const v = e.target.dataset.view; if (v && v !== ui.view) setView(v); };

  /* ================= symbol picker / chips ================= */
  function renderChips() {
    $('#chips').innerHTML = FAV.filter(s => Feed.products[s]).map(s => `<button data-s="${s}" class="chip2 ${s === ui.sym ? 'on' : ''}">${s.replace('USD', '')}</button>`).join('');
  }
  $('#chips').onclick = (e) => { const s = e.target.dataset.s; if (s) selectSymbol(s); };
  function renderSymBtn() {
    const p = P(); if (!p) return;
    const sub = p.kind === 'perp' ? p.desc.replace(/ futures.*$/i, '') : `${p.kind === 'call' ? 'Call' : 'Put'} · Exp ${dayLbl(p.expiry)} ${hhmm(p.expiry)}`;
    $('#symBtn').innerHTML = `${esc(p.symbol)} <small>${esc(sub)}</small>${ui.view === 'futures' ? ' <span class="mut">▾</span>' : ''}`;
    $('#symBtn').classList.toggle('static', ui.view !== 'futures');
    renderChips();
  }
  function renderSymList() {
    const q = $('#symSearch').value.trim().toLowerCase();
    $('#symList').innerHTML = Feed.symbols.filter(s => !q || s.toLowerCase().includes(q) || Feed.products[s].desc.toLowerCase().includes(q)).slice(0, 150).map(s => {
      const t = Feed.tickers[s] || {}, ch = t.open ? (t.last - t.open) / t.open * 100 : 0;
      return `<div class="prow" data-s="${s}"><span>${s}</span><span>${fmt(t.last, Feed.products[s].dp)}</span><span class="${cls(ch)}">${sgn(ch)}%</span></div>`;
    }).join('');
  }
  $('#symBtn').onclick = (e) => { if (ui.view !== 'futures') return; e.stopPropagation(); $('#symPicker').classList.toggle('hidden'); renderSymList(); $('#symSearch').value = ''; $('#symSearch').focus(); };
  $('#symSearch').oninput = renderSymList;
  $('#symList').onclick = (e) => { const r = e.target.closest('.prow'); if (r) { selectSymbol(r.dataset.s); $('#symPicker').classList.add('hidden'); } };
  document.addEventListener('click', (e) => { if (!e.target.closest('#symPicker')) $('#symPicker').classList.add('hidden'); });

  function selectSymbol(s, opts = {}) {
    const p = Feed.products[s]; if (!p) return;
    if (p.kind === 'perp') { ui.perp = s; if (ui.view !== 'futures') { ui.view = 'futures'; } }
    else { ui.opt = s; ui.under = p.under; ui.expiry = p.expiry; if (ui.view !== 'options') ui.view = 'options'; }
    ui.sym = s; saveUi();
    ui.f.price = ui.f.stop = ui.f.tp = ui.f.sl = ''; ui.f.size = '';
    if (opts.price) { ui.f.price = String(opts.price); ui.otype = 'limit'; }
    updateInterest(); renderSymBtn(); renderOrderPanel();
    if (!(ui.view === 'options' && ui.optMode === 'chain')) loadCandles();
    applyViewLight(); dirty(true);
  }
  function applyViewLight() { [...$('#nav').children].forEach(a => a.classList.toggle('on', a.dataset.view === ui.view)); $('#chips').classList.toggle('hidden', ui.view === 'options'); }
  function updateInterest() {
    const set = new Set([ui.sym]);
    for (const a of Engine.state.accounts) { Object.keys(a.positions).forEach(s => set.add(s)); a.orders.forEach(o => set.add(o.symbol)); }
    Feed.setInterest([...set]);
  }

  /* ================= options chain ================= */
  let chainKey = '', chainSyms = '';
  function chainRows() {
    const rows = Feed.chain(ui.under, ui.expiry), spot = Feed.spotOf(ui.under);
    if (ui.showAll || !spot) return rows;
    let idx = rows.findIndex(r => r.strike >= spot); if (idx < 0) idx = rows.length;
    return rows.slice(Math.max(0, idx - 12), Math.min(rows.length, idx + 12));
  }
  function renderChainBar() {
    if (!$('#cbar')) $('#chain').innerHTML = '<div class="cbar" id="cbar"></div><div class="cwrap" id="cwrap"><table class="ctbl" id="ctbl"></table></div>';
    const ex = ensureExpiry();
    $('#cbar').innerHTML = `<div class="seg">${unders().map(u => `<button data-u="${u}" class="${u === ui.under ? 'on' : ''}">${u}</button>`).join('')}</div>
      <div class="exps">${ex.slice(0, 14).map(e => `<button data-e="${e}" class="${e === ui.expiry ? 'on' : ''}">${dayLbl(e)}<small>${left(e)}</small></button>`).join('')}</div>
      <div class="sp"></div><label class="chk2"><input type="checkbox" id="cAll" ${ui.showAll ? 'checked' : ''}>All strikes</label>
      <span class="mut" id="cSpot"></span>`;
    chainKey = '';
  }
  function renderChainTbl(scroll) {
    if (ui.view !== 'options' || ui.optMode !== 'chain' || !$('#ctbl')) return;
    const rows = chainRows(), spot = Feed.spotOf(ui.under), up = Feed.products[ui.sym] ? ui.sym : '';
    const syms = rows.flatMap(r => [r.call, r.put].filter(Boolean)).join(',');
    if (syms !== chainSyms) { chainSyms = syms; Feed.setChain(syms ? syms.split(',') : []); }
    const side = (sym, mirror, itm) => {
      itm = itm ? 'itm' : '';
      const t = Feed.tickers[sym] || {}, p = Feed.products[sym], d = p ? p.dp : 1, g = t.greeks;
      if (!sym) return '<td colspan="5" class="mut">—</td>';
      const cells = [
        `<td class="mut ${itm}">${t.oi ? compact(t.oi) : '--'}</td>`,
        `<td class="mut ${itm}">${t.iv ? (t.iv * 100).toFixed(1) + '%' : '--'}</td>`,
        `<td class="mut ${itm}">${g ? g.delta.toFixed(2) : '--'}</td>`,
        `<td class="q bid ${itm} ${sym === up ? 'sel' : ''}" data-s="${sym}" data-px="${t.bid || ''}">${t.bid ? fmt(t.bid, d) : '--'}<small>${t.bidSize ? compact(t.bidSize) : ''}</small></td>`,
        `<td class="q ask ${itm} ${sym === up ? 'sel' : ''}" data-s="${sym}" data-px="${t.ask || ''}">${t.ask ? fmt(t.ask, d) : '--'}<small>${t.askSize ? compact(t.askSize) : ''}</small></td>`,
      ];
      return (mirror ? [cells[3], cells[4], cells[2], cells[1], cells[0]] : cells).join('');
    };
    let html = `<thead><tr><th class="hc">Call OI</th><th class="hc">IV</th><th class="hc">Delta</th><th class="hc">Bid</th><th class="hc">Ask</th><th class="hs">Strike</th><th class="hp">Bid</th><th class="hp">Ask</th><th class="hp">Delta</th><th class="hp">IV</th><th class="hp">Put OI</th></tr></thead><tbody>`;
    let spotDone = false;
    for (const r of rows) {
      if (!spotDone && spot && r.strike >= spot) { html += `<tr class="spotrow"><td colspan="11"><span>${esc(ui.under)} Spot ${fmt(spot, 2)}</span></td></tr>`; spotDone = true; }
      html += `<tr>${side(r.call, false, r.strike < spot)}<td class="strike">${fmt(r.strike, 0)}</td>${side(r.put, true, r.strike > spot)}</tr>`;
    }
    $('#ctbl').innerHTML = html + '</tbody>';
    $('#cSpot') && ($('#cSpot').textContent = spot ? `Spot ${fmt(spot, 2)}` : '');
    if (scroll || chainKey !== ui.under + ui.expiry) { chainKey = ui.under + ui.expiry; const sr = $('#ctbl .spotrow'); if (sr) $('#cwrap').scrollTop = sr.offsetTop - $('#cwrap').clientHeight / 2; }
  }
  $('#chain').addEventListener('mousedown', (e) => {
    const u = e.target.closest('[data-u]'); if (u) { ui.under = u.dataset.u; ui.expiry = null; ensureExpiry(); ui.opt = pickAtm(); selectSymbol(ui.opt); renderChainBar(); renderChainTbl(true); return; }
    const ex = e.target.closest('[data-e]'); if (ex) { ui.expiry = +ex.dataset.e; ui.opt = pickAtm(); selectSymbol(ui.opt); renderChainBar(); renderChainTbl(true); return; }
    const q = e.target.closest('td.q'); if (q && q.dataset.s) { selectSymbol(q.dataset.s, { price: q.dataset.px || '' }); renderChainTbl(); }
  });
  $('#chain').addEventListener('change', (e) => { if (e.target.id === 'cAll') { ui.showAll = e.target.checked; renderChainTbl(true); } });
  $('#chain').addEventListener('dblclick', (e) => { const q = e.target.closest('td.q'); if (q && q.dataset.s) { selectSymbol(q.dataset.s, { price: q.dataset.px || '' }); ui.optMode = 'chart'; applyView(); } });
  setInterval(() => { if (ui.view === 'options' && ui.optMode === 'chain') renderChainBar(); }, 30000);
  Feed.on('products', () => { if (ui.view === 'options') { ensureExpiry(); renderChainBar(); renderChainTbl(); } });

  /* ================= ticker stats ================= */
  let prevLast = 0, lastDir = '';
  function renderStats() {
    const p = P(), t = T(); if (!p || !t.last && !t.mark) return;
    const px = t.last || t.mark;
    if (px !== prevLast) { lastDir = px > prevLast ? 'buy' : 'sell'; prevLast = px; }
    const ch = t.open ? (px - t.open) / t.open * 100 : 0;
    if (p.kind === 'perp') {
      const ms = Engine.nextFunding() - Date.now(), h = Math.floor(ms / 3.6e6), m = Math.floor(ms % 3.6e6 / 6e4), s = Math.floor(ms % 6e4 / 1e3);
      $('#stats').innerHTML = `
        <div><span class="px ${lastDir}">${fmt(px, p.dp)}</span><small>Mark ${fmt(t.mark, p.dp)}</small></div>
        <div><small>24h Change</small><span class="${cls(ch)}">${sgn(ch)}%</span></div>
        <div><small>24h High</small><span>${fmt(t.high, p.dp)}</span></div>
        <div><small>24h Low</small><span>${fmt(t.low, p.dp)}</span></div>
        <div><small>24h Turnover</small><span>$${compact(t.volUsd)}</span></div>
        <div><small>Open Interest</small><span>$${compact(t.oiUsd)}</span></div>
        <div><small>Funding / Countdown</small><span><b class="${cls(-t.funding)}">${(t.funding * 100).toFixed(4)}%</b> <span class="mut">${z2(h)}:${z2(m)}:${z2(s)}</span></span></div>`;
      document.title = `${fmt(px, p.dp)} ${p.symbol} – Delta Demo`;
    } else {
      const g = t.greeks || {};
      $('#stats').innerHTML = `
        <div><span class="px ${lastDir}">${fmt(t.mark || px, p.dp)}</span><small>Mark · Last ${fmt(t.last, p.dp)}</small></div>
        <div><small>Bid / Ask</small><span><b class="buy">${fmt(t.bid, p.dp)}</b> / <b class="sell">${fmt(t.ask, p.dp)}</b></span></div>
        <div><small>Mark IV</small><span>${t.iv ? (t.iv * 100).toFixed(2) + '%' : '--'}</span></div>
        <div><small>Δ / Γ</small><span>${g.delta !== undefined ? g.delta.toFixed(3) : '--'} / ${g.gamma !== undefined ? g.gamma.toFixed(5) : '--'}</span></div>
        <div><small>Θ / Vega</small><span>${g.theta !== undefined ? g.theta.toFixed(2) : '--'} / ${g.vega !== undefined ? g.vega.toFixed(2) : '--'}</span></div>
        <div><small>Strike / Spot</small><span>${fmt(p.strike, 0)} / ${fmt(Engine.spotOf(ui.sym), 1)}</span></div>
        <div><small>Open Interest</small><span>${compact(t.oi || 0)}</span></div>
        <div><small>Expires in</small><span class="${p.expiry - Date.now() < 3.6e6 ? 'sell' : ''}">${left(p.expiry)} <span class="mut">${dayLbl(p.expiry)} ${hhmm(p.expiry)}</span></span></div>`;
      document.title = `${p.symbol} ${fmt(t.mark, p.dp)} – Delta Demo`;
    }
  }

  /* ================= order book / trades ================= */
  function renderBook() {
    const p = P(), b = Feed.books[ui.sym], t = T();
    if (!b) { $('#bookView').innerHTML = '<div class="empty">Loading order book…</div>'; return; }
    const N = Math.max(8, Math.min(16, Math.floor(($('#bookView').clientHeight - 80) / 40)));
    const asks = b.asks.slice(0, N), bids = b.bids.slice(0, N);
    const maxD = Math.max(asks[asks.length - 1] ? asks[asks.length - 1].d : 1, bids[bids.length - 1] ? bids[bids.length - 1].d : 1);
    const row = (l, c) => `<div class="brow ${c}" data-p="${l.p}"><i style="width:${l.d / maxD * 100}%"></i><span class="${c === 'a' ? 'sell' : 'buy'}">${fmt(l.p, p.dp)}</span><span>${fmt(l.s, 0)}</span><span>${fmt(l.d, 0)}</span></div>`;
    const spread = asks[0] && bids[0] ? asks[0].p - bids[0].p : 0;
    $('#bookView').innerHTML = `<div class="book-hdr"><span>Price (USD)</span><span>Size</span><span>Total</span></div>
      ${asks.slice().reverse().map(l => row(l, 'a')).join('')}
      <div class="mid"><span class="${lastDir}">${fmt(t.last || t.mark, p.dp)}</span><small>Spread ${fmt(spread, p.dp)}</small></div>
      ${bids.map(l => row(l, 'b')).join('')}`;
  }
  $('#bookView').onclick = (e) => { const r = e.target.closest('.brow'); if (!r) return; setField('price', r.dataset.p); };
  function renderTrades() {
    const p = P(), tr = Feed.trades[ui.sym] || [];
    $('#tradesView').innerHTML = `<div class="book-hdr"><span>Price</span><span>Size</span><span>Time</span></div>` + tr.slice(0, 40).map(x =>
      `<div class="trow"><span class="${x.side}">${fmt(x.price, p.dp)}</span><span>${fmt(x.size, 0)}</span><span class="mut">${new Date(x.ts * 1000).toLocaleTimeString([], { hour12: false })}</span></div>`).join('') || '<div class="empty">No recent trades</div>';
  }
  $('#bookTabs').onclick = (e) => {
    const t = e.target.dataset.t; if (!t) return; ui.bookTab = t;
    [...$('#bookTabs').children].forEach(a => a.classList.toggle('on', a.dataset.t === t));
    $('#bookView').classList.toggle('hidden', t !== 'book'); $('#tradesView').classList.toggle('hidden', t !== 'trades');
  };

  /* ================= order panel ================= */
  const TYPES = [['limit', 'Limit'], ['market', 'Market'], ['stop_limit', 'Stop Limit'], ['stop_market', 'Stop Market']];
  function renderOrderPanel() {
    const p = P(); if (!p) return;
    const a = Engine.active, opt = p.kind !== 'perp', lev = Engine.levOf(a, ui.sym), f = ui.f, ty = ui.otype;
    const isLimit = ty === 'limit' || ty === 'stop_limit', isStop = ty.startsWith('stop');
    const feeTxt = opt ? '0.01% of spot (max 12.5% of premium) + GST' : `${(p.taker * 100 * 1.18).toFixed(3)}% / ${(p.maker * 100 * 1.18).toFixed(3)}%`;
    $('#orderPanel').innerHTML = `<div class="op">
      <div class="op-top"><span class="opname">${esc(p.symbol)}</span>${opt ? '<span class="pill">Premium · no leverage</span>' : `<span class="pill">Isolated</span><button class="pill" id="levBtn">Leverage ${lev}x ✎</button>`}</div>
      <div class="otabs">${TYPES.map(([k, l]) => `<a data-ty="${k}" class="${k === ty ? 'on' : ''}">${l}</a>`).join('')}</div>
      ${isStop ? `<div class="fld"><label>Trigger Price<select id="fTrig" style="background:none;border:0;color:var(--mut)"><option value="mark"${f.trigger === 'mark' ? ' selected' : ''}>Mark</option><option value="last"${f.trigger === 'last' ? ' selected' : ''}>Last</option></select></label>
        <div class="inp"><input id="fStop" inputmode="decimal" value="${f.stop}"><em>USD</em></div></div>` : ''}
      ${isLimit ? `<div class="fld"><label>Limit Price</label><div class="inp"><input id="fPrice" inputmode="decimal" value="${f.price}"><button id="pBid">Bid</button><button id="pAsk">Ask</button><button id="pLast">Last</button><em>USD</em></div></div>` : ''}
      <div class="fld"><label>Size <span id="sizeHint"></span></label><div class="inp"><input id="fSize" inputmode="numeric" value="${f.size}" placeholder="0"><em>Contracts</em></div></div>
      <input type="range" id="fPct" min="0" max="100" value="0" step="1">
      <div class="chk">
        <label><input type="checkbox" id="fRed" ${f.reduce ? 'checked' : ''}>Reduce-Only</label>
        ${ty === 'limit' ? `<label><input type="checkbox" id="fPost" ${f.post ? 'checked' : ''}>Post-Only</label>` : ''}
        ${opt ? '' : `<label><input type="checkbox" id="fTpOn" ${f.tpOn ? 'checked' : ''}>TP / SL</label>`}
      </div>
      ${f.tpOn && !opt ? `<div class="bs"><div class="inp"><input id="fTp" placeholder="Take profit" inputmode="decimal" value="${f.tp}"></div><div class="inp"><input id="fSl" placeholder="Stop loss" inputmode="decimal" value="${f.sl}"></div></div>` : ''}
      <div class="bs"><button class="b" data-side="buy">${opt ? 'Buy' : 'Buy / Long'}<small id="bpx"></small></button><button class="s" data-side="sell">${opt ? 'Sell' : 'Sell / Short'}<small id="spx"></small></button></div>
      <div class="sec"><div class="kv"><span>${opt ? 'Premium / margin' : 'Margin required'}</span><b id="kCost">--</b></div><div class="kv"><span>Max size (buy)</span><b id="kMax">--</b></div>
        <div class="kv"><span>${opt ? 'Fee' : 'Fees (taker / maker)'}</span><b>${feeTxt}</b></div></div>
      <div class="sec" id="accSum"></div></div>`;
    const op = $('#orderPanel');
    op.querySelector('.otabs').onclick = (e) => { const k = e.target.dataset.ty; if (k) { ui.otype = k; renderOrderPanel(); } };
    $('#levBtn') && ($('#levBtn').onclick = openLeverage);
    const bind = (id, key) => { const el = $(id); if (el) el.oninput = () => { ui.f[key] = el.value; dirty(); }; };
    bind('#fStop', 'stop'); bind('#fPrice', 'price'); bind('#fTp', 'tp'); bind('#fSl', 'sl');
    const fs = $('#fSize'); fs.oninput = () => { ui.f.size = fs.value.replace(/\D/g, ''); fs.value = ui.f.size; $('#fPct').value = 0; dirty(); };
    $('#fTrig') && ($('#fTrig').onchange = (e) => ui.f.trigger = e.target.value);
    $('#fRed').onchange = (e) => ui.f.reduce = e.target.checked;
    $('#fPost') && ($('#fPost').onchange = (e) => ui.f.post = e.target.checked);
    $('#fTpOn') && ($('#fTpOn').onchange = (e) => { ui.f.tpOn = e.target.checked; renderOrderPanel(); });
    $('#pLast') && ($('#pLast').onclick = () => setField('price', (T().last || T().mark).toFixed(p.dp)));
    $('#pBid') && ($('#pBid').onclick = () => T().bid && setField('price', T().bid.toFixed(p.dp)));
    $('#pAsk') && ($('#pAsk').onclick = () => T().ask && setField('price', T().ask.toFixed(p.dp)));
    $('#fPct').oninput = (e) => { const m = maxSize(); ui.f.size = String(Math.floor(m * e.target.value / 100)); fs.value = ui.f.size; dirty(); };
    op.querySelectorAll('.bs button[data-side]').forEach(b => b.onclick = () => submit(b.dataset.side));
    const ref = T().last || T().mark;
    if (isLimit && !ui.f.price && ref) { ui.f.price = ref.toFixed(p.dp); $('#fPrice').value = ui.f.price; }
    if (isStop && !ui.f.stop && ref) { ui.f.stop = ref.toFixed(p.dp); $('#fStop').value = ui.f.stop; }
    dirty();
  }
  function setField(k, v) { ui.f[k] = String(v); const id = { price: '#fPrice', stop: '#fStop' }[k]; if (id && $(id)) $(id).value = ui.f[k]; if (k === 'price' && ui.otype === 'market') { ui.otype = 'limit'; renderOrderPanel(); } dirty(); }

  function refPrice(side) {
    const t = T(), ty = ui.otype;
    if ((ty === 'limit' || ty === 'stop_limit') && +ui.f.price > 0) return +ui.f.price;
    if (ty.startsWith('stop') && +ui.f.stop > 0) return +ui.f.stop;
    return (side === 'sell' ? t.bid : t.ask) || t.last || t.mark || 0;
  }
  function maxSize() {
    const a = Engine.active, p = P(), pos = a.positions[ui.sym], px = refPrice('buy');
    if (!px) return 0;
    const per = Engine.marginUnit(ui.sym, 'buy', px, Engine.levOf(a, ui.sym)) + Engine.feeUnit(ui.sym, px, 'taker');
    const avail = Math.max(0, Engine.summary(a).available);
    return Math.min(p.posLimit, Math.floor(avail / per) + (pos ? Math.abs(pos.size) : 0));
  }
  function updateOrderDyn() {
    if (!$('#kCost')) return;
    const p = P(), a = Engine.active, t = T(), sz = +ui.f.size || 0;
    $('#bpx').textContent = fmt(t.ask, p.dp); $('#spx').textContent = fmt(t.bid, p.dp);
    const probe = { symbol: ui.sym, side: 'buy', size: sz, filled: 0, price: refPrice('buy'), reduceOnly: ui.f.reduce, status: 'open' };
    const c1 = Engine.orderMargin(a, probe), c2 = Engine.orderMargin(a, { ...probe, side: 'sell', price: refPrice('sell') });
    $('#kCost').textContent = sz ? `${fmt(Math.max(c1, c2))} USD` : '--';
    $('#kMax').textContent = `${fmt(maxSize(), 0)} contracts`;
    $('#sizeHint').textContent = sz ? `≈ ${fmt(sz * p.cv, 4)} ${p.unit || p.base}` : `1 contract = ${p.cv} ${p.unit || p.base}`;
    const s = Engine.summary(a);
    $('#accSum').innerHTML = `<div class="kv"><span>Equity</span><b>${fmt(s.equity)} USD</b></div><div class="kv"><span>Available balance</span><b>${fmt(s.available)} USD</b></div><div class="kv"><span>Unrealised PnL</span><b class="${cls(s.upnl)}">${sgn(s.upnl)} USD</b></div>`;
  }

  async function submit(side) {
    const a = Engine.active, f = ui.f, p = P();
    const o = { symbol: ui.sym, side, type: ui.otype, size: f.size, price: f.price, stop: f.stop, trigger: f.trigger, reduceOnly: f.reduce, postOnly: f.post && ui.otype === 'limit' };
    if (f.tpOn && p.kind === 'perp') {
      const ref = refPrice(side), tp = +f.tp || null, sl = +f.sl || null;
      if (tp && (side === 'buy' ? tp <= ref : tp >= ref)) return toast('error', 'Take profit is on the wrong side of the entry price');
      if (sl && (side === 'buy' ? sl >= ref : sl <= ref)) return toast('error', 'Stop loss is on the wrong side of the entry price');
      o.tp = tp; o.sl = sl;
    }
    const r = await Engine.place(a, o);
    if (!r.ok) return toast('error', r.error);
    if (r.order.status !== 'filled' && r.order.filled === 0) toast('info', `${o.type.replace('_', ' ')} ${side} order placed – ${r.order.size} ${ui.sym}${r.order.price ? ' @ ' + fmt(r.order.price, p.dp) : ''}`);
  }

  /* ================= bottom tables ================= */
  const botTabs = [['positions', 'Positions'], ['orders', 'Open Orders'], ['stops', 'Stop Orders'], ['fills', 'Fills'], ['history', 'Order History'], ['account', 'Account']];
  function renderBotTabs() {
    const a = Engine.active;
    const cnt = { positions: Object.keys(a.positions).length, orders: a.orders.filter(o => o.status === 'open').length, stops: a.orders.filter(o => o.status === 'untriggered').length };
    $('#botTabs').innerHTML = botTabs.map(([k, l]) => `<a data-k="${k}" class="${k === ui.botTab ? 'on' : ''}">${l}${cnt[k] ? ` (${cnt[k]})` : ''}</a>`).join('') +
      '<span class="grow"></span>' + (ui.botTab === 'positions' ? '<a class="act" data-k="closeall">Close all</a>' : ui.botTab === 'orders' || ui.botTab === 'stops' ? '<a class="act" data-k="cancelall">Cancel all</a>' : '');
  }
  $('#botTabs').onclick = (e) => {
    const k = e.target.dataset.k; if (!k) return;
    if (k === 'closeall') return Engine.closeAll(Engine.active);
    if (k === 'cancelall') return Engine.cancelAll(Engine.active);
    ui.botTab = k; dirty(true);
  };
  const time = (ts) => new Date(ts).toLocaleString([], { hour12: false, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dp = (s) => Feed.products[s] ? Feed.products[s].dp : 2;
  const typeName = (o) => o.type.replace('_', ' ');

  function botHtml() {
    const a = Engine.active, k = ui.botTab;
    const tbl = (head, rows, msg) => rows.length ? `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>` : `<div class="empty">${msg}</div>`;
    if (k === 'positions') {
      return tbl(['Symbol', 'Size', 'Entry Price', 'Mark Price', 'Liq. Price', 'Margin', 'Unrealised PnL', 'TP / SL', 'Close Position'], Object.entries(a.positions).map(([s, pos]) => {
        const p = Feed.products[s], o = p.kind !== 'perp', u = Engine.upnl(pos, s), d = p.dp, roe = pos.margin ? u / pos.margin * 100 : 0, mk = (Feed.tickers[s] || {}).mark || pos.entry;
        return `<tr><td><a data-sym="${s}" style="cursor:pointer"><b>${s}</b></a> ${o ? '' : `<span class="chip">${pos.lev}x</span>`}${o ? `<small class="mut" style="display:block">expires ${dayLbl(p.expiry)} ${hhmm(p.expiry)} (${left(p.expiry)})</small>` : ''}</td>
          <td class="${pos.size > 0 ? 'buy' : 'sell'}">${fmt(pos.size, 0)} <span class="mut">(${fmt(Math.abs(pos.size) * p.cv, 4)} ${p.unit || p.base})</span></td>
          <td>${fmt(pos.entry, d)}</td><td>${fmt(mk, d)}</td><td style="color:#e0a030">${o ? '--' : fmt(Engine.liqPrice(pos, s), d)}</td><td>${fmt(pos.margin)}</td>
          <td class="${cls(u)}">${sgn(u)} (${sgn(roe)}%)</td>
          <td>${o ? '--' : `<a data-act="tpsl" data-s="${s}" style="cursor:pointer">${pos.tp ? fmt(pos.tp, d) : '--'} / ${pos.sl ? fmt(pos.sl, d) : '--'} ✎</a>`}</td>
          <td><button class="btn" data-act="cm" data-s="${s}">Market</button> <button class="btn" data-act="cl" data-s="${s}">Limit</button></td></tr>`;
      }), 'No open positions');
    }
    if (k === 'orders' || k === 'stops') {
      const list = a.orders.filter(o => (k === 'orders') === (o.status === 'open'));
      return tbl(['Symbol', 'Type', 'Side', 'Size', 'Filled', k === 'stops' ? 'Trigger' : 'Price', 'Flags', 'Time', ''], list.map(o => `<tr><td><b>${o.symbol}</b></td><td>${typeName(o)}</td><td class="${o.side === 'buy' ? 'buy' : 'sell'}">${o.side}</td>
        <td>${fmt(o.size, 0)}</td><td>${fmt(o.filled, 0)}</td><td>${k === 'stops' ? `${o.dir === 'up' ? '≥' : '≤'} ${fmt(o.stop, dp(o.symbol))} (${o.trigger})` : fmt(o.price, dp(o.symbol))}${k === 'stops' && o.price ? ' → ' + fmt(o.price, dp(o.symbol)) : ''}</td>
        <td class="mut">${o.reduceOnly ? 'Reduce ' : ''}${o.postOnly ? 'Post ' : ''}</td><td class="mut">${time(o.ts)}</td><td><button class="btn dng" data-act="cx" data-id="${o.id}">Cancel</button></td></tr>`), k === 'orders' ? 'No open orders' : 'No stop orders');
    }
    if (k === 'fills') return tbl(['Time', 'Symbol', 'Side', 'Size', 'Price', 'Role', 'Fee (incl. GST)', 'Realised PnL'], a.fills.slice(0, 100).map(x =>
      `<tr><td class="mut">${time(x.ts)}</td><td>${x.symbol}</td><td class="${x.side === 'buy' ? 'buy' : 'sell'}">${x.side}</td><td>${fmt(x.size, 0)}</td><td>${fmt(x.price, dp(x.symbol))}</td><td>${x.role}</td><td>${fmt(x.fee, 4)}</td><td class="${cls(x.realized)}">${x.realized ? sgn(x.realized) : '--'}</td></tr>`), 'No fills yet');
    if (k === 'history') return tbl(['Time', 'Symbol', 'Type', 'Side', 'Size', 'Filled', 'Avg. price', 'Status'], a.history.slice(0, 100).map(o =>
      `<tr><td class="mut">${time(o.ts)}</td><td>${o.symbol}</td><td>${typeName(o)}</td><td class="${o.side === 'buy' ? 'buy' : 'sell'}">${o.side}</td><td>${fmt(o.size, 0)}</td><td>${fmt(o.filled, 0)}</td><td>${o.avg ? fmt(o.avg, dp(o.symbol)) : '--'}</td><td>${o.status.replace(/_/g, ' ')}${o.reason && o.reason !== 'user' ? ` <span class="mut">(${o.reason})</span>` : ''}</td></tr>`), 'No order history');
    const s = Engine.summary(a), pnl = s.equity - a.initial;
    return `<table><tbody>${[['Account', esc(a.name)], ['Wallet balance', fmt(s.balance) + ' USD'], ['Unrealised PnL', `<span class="${cls(s.upnl)}">${sgn(s.upnl)} USD</span>`], ['Equity', fmt(s.equity) + ' USD'],
      ['Position margin', fmt(s.posMargin) + ' USD'], ['Order margin', fmt(s.ordMargin) + ' USD'], ['Available balance', fmt(s.available) + ' USD'], ['Realised PnL', `<span class="${cls(a.realized)}">${sgn(a.realized)} USD</span>`],
      ['Fees paid', fmt(a.fees) + ' USD'], ['Funding paid', `<span class="${cls(-a.funding)}">${fmt(a.funding)} USD</span>`], ['Total PnL since start', `<span class="${cls(pnl)}">${sgn(pnl)} USD</span>`]].map(([l, v]) => `<tr><td class="mut" style="width:220px">${l}</td><td>${v}</td></tr>`).join('')}</tbody></table>`;
  }
  $('#botView').onclick = async (e) => {
    const sym = e.target.closest('[data-sym]'); if (sym) return selectSymbol(sym.dataset.sym);
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = Engine.active, s = b.dataset.s;
    if (b.dataset.act === 'cx') Engine.cancel(a, +b.dataset.id);
    if (b.dataset.act === 'cm') { const r = await Engine.closePosition(a, s, 'market'); if (!r.ok) toast('error', r.error); }
    if (b.dataset.act === 'cl') ask(`Close ${s} at limit`, [{ k: 'price', label: 'Limit price', value: (Feed.tickers[s] || {}).last || '' }], async (v) => { const r = await Engine.closePosition(a, s, 'limit', +v.price); if (!r.ok) toast('error', r.error); });
    if (b.dataset.act === 'tpsl') { const pos = a.positions[s]; ask(`${s} Take Profit / Stop Loss`, [{ k: 'tp', label: 'Take profit price (blank to clear)', value: pos.tp || '' }, { k: 'sl', label: 'Stop loss price (blank to clear)', value: pos.sl || '' }], async (v) => { const r = await Engine.setTpSl(a, s, +v.tp || null, +v.sl || null); if (!r.ok) toast('error', r.error); }); }
  };

  /* ================= accounts (profile icon in the header) ================= */
  function renderAcct() {
    const act = Engine.active; if (!act) return;
    renderHdr(act, Engine.summary(act));
  }
  /* ---- profile icon in the header: switch / edit accounts ---- */
  const hue = (str) => { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const avatarStyle = (name) => `background:hsl(${hue(name)} 55% 42%)`;
  let hdrBuilt = false;
  function renderHdr(act, s) {
    if (!hdrBuilt) {
      $('#hdrAcct').innerHTML = '<div class="hstats" id="hStats"></div><div class="prof"><button id="profBtn" class="profbtn" title="Switch or edit account"></button><div id="profMenu" class="menu hidden"></div></div>';
      hdrBuilt = true;
    }
    $('#hStats').innerHTML = `<div class="hs"><small>Equity</small><b>${fmt(s.equity)}</b></div><div class="hs"><small>Available</small><b>${fmt(s.available)}</b></div><div class="hs"><small>Unrealised PnL</small><b class="${cls(s.upnl)}">${sgn(s.upnl)}</b></div>`;
    const ch = (act.name.trim()[0] || '?').toUpperCase(), html = `<span class="avatar" style="${avatarStyle(act.name)}">${esc(ch)}</span><span class="pname">${esc(act.name)}</span><span class="caret">▾</span>`;
    const b = $('#profBtn'); if (b.dataset.h !== html) { b.dataset.h = html; b.innerHTML = html; }
  }
  function renderProfMenu() {
    const list = Engine.state.accounts, act = Engine.active, s = Engine.summary(act);
    $('#profMenu').innerHTML = `<div class="mhead"><span class="avatar big" style="${avatarStyle(act.name)}">${esc((act.name.trim()[0] || '?').toUpperCase())}</span><div><b>${esc(act.name)}</b><small class="mut" style="display:block">Equity ${fmt(s.equity)} USD</small></div></div>
      <div class="sec2">Switch account</div>` +
      list.map(a => { const q = Engine.summary(a); return `<div class="row ${a.id === act.id ? 'on' : ''}" data-sw="${a.id}"><span>${a.id === act.id ? '✓ ' : ''}<b>${esc(a.name)}</b></span><span style="text-align:right">${fmt(q.equity)}<br><small class="${cls(q.equity - a.initial)}">${sgn(q.equity - a.initial)}</small></span></div>`; }).join('') +
      `<div class="mf"><div class="sec2">Edit "${esc(act.name)}"</div>
        <div class="row" data-pa="rn"><span>Rename</span></div><div class="row" data-pa="dp"><span>Add funds</span></div>
        <div class="row" data-pa="rs"><span>Reset account</span></div><div class="row dng" data-pa="dl"><span>Delete account</span></div></div>
      <div class="mf"><div class="row" data-pa="new"><b>+ New demo account</b></div><div class="row" data-pa="all"><span>Manage all accounts</span></div></div>`;
  }
  $('#hdrAcct').addEventListener('click', (e) => {
    if (e.target.closest('#profBtn')) { const m = $('#profMenu'); if (m.classList.contains('hidden')) { renderProfMenu(); m.classList.remove('hidden'); } else m.classList.add('hidden'); }
  });
  $('#hdrAcct').addEventListener('mousedown', (e) => {
    const m = $('#profMenu'); if (!m || !e.target.closest('#profMenu')) return;
    const sw = e.target.closest('[data-sw]'), pa = e.target.closest('[data-pa]');
    if (sw) { m.classList.add('hidden'); if (sw.dataset.sw !== Engine.active.id) { Engine.switchAccount(sw.dataset.sw); toast('info', `Switched to ${Engine.active.name}`); } return; }
    if (!pa) return;
    m.classList.add('hidden'); const id = Engine.active.id;
    ({ rn: () => acctRename(id), dp: () => acctFund(id), rs: () => acctReset(id), dl: () => acctDelete(id), new: newAccountDialog, all: manageAccounts })[pa.dataset.pa]();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.prof')) { const m = $('#profMenu'); if (m) m.classList.add('hidden'); } });
  function acctRename(id, after) { const a = Engine.state.accounts.find(x => x.id === id); ask('Rename account', [{ k: 'name', label: 'Name', value: a.name, text: true }], async v => { await Engine.renameAccount(id, v.name); after && after(); }); }
  function acctFund(id, after) { ask('Add funds', [{ k: 'amt', label: 'Amount (USD)', value: 1000 }], async v => { await Engine.deposit(id, +v.amt); toast('success', 'Funds added'); after && after(); }); }
  function acctReset(id, after) { const a = Engine.state.accounts.find(x => x.id === id); ask('Reset account', [{ k: 'bal', label: 'New starting balance (USD) – clears positions, orders and history', value: a.initial }], async v => { await Engine.resetAccount(id, +v.bal); toast('info', 'Account reset'); after && after(); }); }
  function acctDelete(id, after) {
    const a = Engine.state.accounts.find(x => x.id === id);
    ask(`Delete "${a.name}"? Type OK to confirm`, [{ k: 'c', label: 'This removes its positions, orders and history permanently', value: '', text: true }], async v => {
      if (v.c.trim().toUpperCase() !== 'OK') return toast('info', 'Delete cancelled');
      const r = await Engine.deleteAccount(id); if (!r.ok) return toast('error', r.error); toast('info', 'Account deleted'); after && after();
    });
  }
  function newAccountDialog() {
    ask('New demo account', [{ k: 'name', label: 'Account name', value: `Account ${Engine.state.accounts.length + 1}`, text: true }, { k: 'bal', label: 'Starting balance (USD)', value: 10000 }],
      async (v) => { const r = await Engine.createAccount(v.name, +v.bal); if (!r.ok) return toast('error', r.error); toast('success', `Created ${Engine.active.name}`); });
  }
  function manageAccounts() {
    const rows = () => Engine.state.accounts.map(a => { const s = Engine.summary(a); return `<tr><td><b>${esc(a.name)}</b>${a.id === Engine.active.id ? ' <span class="chip">active</span>' : ''}</td><td>${fmt(s.equity)}</td><td class="${cls(s.equity - a.initial)}">${sgn(s.equity - a.initial)}</td>
      <td style="text-align:right"><button class="btn" data-a="sw" data-id="${a.id}">Switch</button> <button class="btn" data-a="rn" data-id="${a.id}">Rename</button> <button class="btn" data-a="dp" data-id="${a.id}">Add funds</button> <button class="btn" data-a="rs" data-id="${a.id}">Reset</button> <button class="btn dng" data-a="dl" data-id="${a.id}">Delete</button></td></tr>`; }).join('');
    const draw = () => { modal(`<h3>Demo accounts <button class="x" data-close>×</button></h3><table><thead><tr><th>Name</th><th>Equity (USD)</th><th>PnL</th><th></th></tr></thead><tbody>${rows()}</tbody></table><div class="mrow"><button class="btn pri" data-a="new">+ New demo account</button></div>`); };
    draw();
    $('#mbox').onclick = (e) => {
      if (e.target.closest('[data-close]')) return closeModal();
      const b = e.target.closest('[data-a]'); if (!b) return;
      const id = b.dataset.id, a = Engine.state.accounts.find(x => x.id === id), act = b.dataset.a;
      const redo = () => { manageAccounts(); };
      if (act === 'new') return newAccountDialog();
      if (act === 'sw') { Engine.switchAccount(id); draw(); }
      if (act === 'rn') acctRename(id, redo);
      if (act === 'dp') acctFund(id, redo);
      if (act === 'rs') acctReset(id, redo);
      if (act === 'dl') acctDelete(id, redo);
    };
  }

  /* ================= modals / toasts ================= */
  function modal(html) { $('#mbox').innerHTML = html; $('#modal').classList.remove('hidden'); }
  function closeModal() { $('#modal').classList.add('hidden'); $('#mbox').onclick = null; }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  function ask(title, fields, cb) {
    modal(`<h3>${esc(title)} <button class="x" data-close>×</button></h3>` + fields.map(f => `<div class="fld" style="margin-top:10px"><label>${esc(f.label)}</label><div class="inp"><input data-k="${f.k}" value="${esc(f.value)}" ${f.text ? '' : 'inputmode="decimal"'}></div></div>`).join('') +
      '<div class="mrow" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn pri" id="askOk">Confirm</button></div>');
    const go = () => { const v = {}; $('#mbox').querySelectorAll('input[data-k]').forEach(i => v[i.dataset.k] = i.value); closeModal(); cb(v); };
    $('#askOk').onclick = go;
    $('#mbox').onclick = (e) => { if (e.target.closest('[data-close]')) closeModal(); };
    $('#mbox').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    const first = $('#mbox input'); first.focus(); first.select();
  }
  function openLeverage() {
    const a = Engine.active, p = P(), cur = Engine.levOf(a, ui.sym);
    const presets = [...new Set([1, 2, 5, 10, 25, 50, 100, 200, p.maxLev].filter(x => x <= p.maxLev))];
    modal(`<h3>${ui.sym} leverage <button class="x" data-close>×</button></h3><div class="mut" style="margin-bottom:10px">Isolated margin · max ${p.maxLev}x. ${a.positions[ui.sym] ? 'Changing leverage re-sizes margin on your open position.' : ''}</div>
      <input type="range" id="lvR" min="1" max="${p.maxLev}" value="${cur}"><div class="mrow"><div class="inp"><input id="lvN" value="${cur}" inputmode="numeric"><em>x</em></div></div>
      <div class="mrow">${presets.map(x => `<button class="btn" data-lv="${x}">${x}x</button>`).join('')}</div>
      <div class="mrow" style="justify-content:flex-end"><button class="btn pri" id="lvOk">Confirm</button></div>`);
    const r = $('#lvR'), n = $('#lvN'); r.oninput = () => n.value = r.value; n.oninput = () => r.value = n.value;
    $('#mbox').onclick = (e) => { if (e.target.closest('[data-close]')) closeModal(); const b = e.target.closest('[data-lv]'); if (b) { n.value = r.value = b.dataset.lv; } };
    $('#lvOk').onclick = async () => { const res = await Engine.setLeverage(a, ui.sym, +n.value); if (!res.ok) return toast('error', res.error); closeModal(); renderOrderPanel(); };
  }
  function toast(type, msg) {
    const el = document.createElement('div'); el.className = 'toast ' + type; el.textContent = msg; $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4500); while ($('#toasts').children.length > 5) $('#toasts').firstChild.remove();
  }

  /* ================= wiring & render loop ================= */
  let pending = false, force = false, lastBot = 0, lastChain = 0;
  function dirty(f) { force = force || !!f; if (!pending) { pending = true; requestAnimationFrame(frame); setTimeout(frame, 80); } }
  function frame() {
    if (!pending) return;
    pending = false;
    renderStats(); if (ui.bookTab === 'book') renderBook(); else renderTrades();
    updateOrderDyn(); renderAcct();
    const now = performance.now();
    if (ui.view === 'options' && ui.optMode === 'chain' && now - lastChain > 400) { renderChainTbl(); lastChain = now; }
    if (force || now - lastBot > 250) { renderBotTabs(); const bv = $('#botView'), st = bv.scrollTop; bv.innerHTML = botHtml(); bv.scrollTop = st; lastBot = now; force = false; }
  }
  Feed.on('ticker', (s) => { if (s === ui.sym || (Engine.active && Engine.active.positions[s]) || ui.view === 'options') dirty(); });
  Feed.on('book', (s) => { if (s === ui.sym) dirty(); });
  Feed.on('trade', (s) => { if (s === ui.sym) dirty(); });
  Feed.on('trades', (s) => { if (s === ui.sym) dirty(); });
  Feed.on('status', () => { const el = $('#feedWarn'); el.classList.toggle('hidden', Feed.status === 'live'); el.textContent = Feed.status === 'connecting' ? 'Connecting…' : 'Market feed reconnecting…'; }); // shown only when the feed is down
  Engine.onChange((kind, p) => {
    if (kind === 'fill' && p) {
      const f = p.order, who = p.acct.id === Engine.active.id ? '' : `[${p.acct.name}] `;
      toast(f.side === 'buy' ? 'success' : 'error', `${who}${f.side === 'buy' ? 'Bought' : 'Sold'} ${fmt(p.qty, 0)} ${f.symbol} @ ${fmt(p.px, dp(f.symbol))} (${p.role})`);
      return;
    }
    if (kind === 'toast') return toast(p.type, p.msg);
    if (kind === 'conn') { toast(Client.connected ? 'success' : 'error', Client.connected ? 'Connected to server' : 'Server connection lost – reconnecting'); return; }
    if (kind === 'accounts') renderOrderPanel();
    updateInterest(); refreshLines(); dirty(true);
  });
  setInterval(() => dirty(), 1000);
  window.addEventListener('resize', () => dirty());

  /* ================= boot ================= */
  if (ui.view === 'options' && unders().length) { if (!unders().includes(ui.under)) ui.under = unders()[0]; ensureExpiry(); if (!ui.opt || !Feed.products[ui.opt]) ui.opt = pickAtm(); ui.sym = ui.opt; }
  else { ui.view = 'futures'; ui.sym = ui.perp; }
  candles.applyOptions({ visible: ui.ctype === 'candles' }); lineS.applyOptions({ visible: ui.ctype === 'line' });
  renderOrderPanel(); updateInterest(); applyView(); dirty(true);
  Feed.emit('status');
})();
