(async function () {
  const $ = (s, e = document) => e.querySelector(s);
  const fmt = (n, d = 2) => Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '--';
  /* USD / INR display for position values. Delta India converts at a fixed ₹85 per $1
     (fiat_to_usd.asset_to_fiat_value in its public /v2/settings), not the market rate. */
  const USD_INR = 85;
  const ccyAmt = (v, d = 2) => ui.ccy === 'INR' ? (Number.isFinite(v) ? (v * USD_INR).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }) : '--') : fmt(v, d);
  const ccyUnit = () => ui.ccy === 'INR' ? 'INR' : 'USD', ccySym = () => ui.ccy === 'INR' ? '₹' : '$';
  const compact = (n) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cls = (n) => n > 0 ? 'buy' : n < 0 ? 'sell' : '';
  const sgn = (n, d = 2) => (n > 0 ? '+' : '') + fmt(n, d);
  const z2 = (n) => String(n).padStart(2, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayLbl = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MON[d.getMonth()]}`; };
  const hhmm = (ms) => { const d = new Date(ms); return `${z2(d.getHours())}:${z2(d.getMinutes())}`; };
  const ttl = (ms) => { const s = Math.max(0, Math.floor((ms - Date.now()) / 1000)); return `${Math.floor(s / 86400)}d:${z2(Math.floor(s % 86400 / 3600))}h:${z2(Math.floor(s % 3600 / 60))}m`; };
  const left = (ms) => { const s = Math.max(0, Math.floor((ms - Date.now()) / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${z2(s % 60)}s`; };
  const num1 = (v, d) => Number.isFinite(v) ? String(+v.toFixed(d)) : '--'; // Delta style: no thousands separators, trailing zeros trimmed
  const usd = (v, d) => v ? '$' + v.toFixed(d) : '--';
  const decOf = (v) => (String(v).split('.')[1] || '').length;

  const saved = (() => { try { return JSON.parse(localStorage.getItem('dx_ui2')) || {}; } catch (_) { return {}; } })();
  const ui = {
    view: 'options', perp: saved.perp || 'BTCUSD', opt: saved.opt || null, under: saved.under || 'BTC', expiry: null, optMode: 'chain',
    sym: null, otype: 'limit', side: 'buy', botTab: 'positions', posFilter: 'all', posQ: '', posAsc: false, posOff: new Set(), ordOff: new Set(), ordAsc: false, pageSize: +saved.pageSize || 30, pages: {}, cols: saved.cols || {}, colLabels: {}, ccy: saved.ccy === 'INR' ? 'INR' : 'USD',
    f: { size: '', qty: '', unit: 'lot', price: '', stop: '', trigger: 'mark', reduce: false, post: false, tpOn: false, tp: '', sl: '', tif: 'gtc' },
    lev: { open: false, draft: 0, def: false }, ores: saved.ores || '1h', osrc: saved.osrc || 'mark', fres: saved.fres || '1h', fsrc: saved.fsrc || 'traded', pickTab: 'futures', cdOpen: false, mtab: 'markets', mk: 'options', cview: 'price', moreOpen: false, oneClick: saved.oneClick !== false, ocQty: 1, ddOpen: false, feesOpen: false, grkOpen: false, specOpen: false, obGroup: 0, obgOpen: false, strikeDesc: false,
  };
  const watch = new Set(saved.watch || []); // ☆ markets in the picker's Watchlist tab
  const hiddenCols = new Set(saved.hiddenCols || []); // option chain columns switched off in the column picker
  const saveUi = () => { try { localStorage.setItem('dx_ui2', JSON.stringify({ view: ui.view, perp: ui.perp, opt: ui.opt, under: ui.under, hiddenCols: [...hiddenCols], ores: ui.ores, osrc: ui.osrc, fres: ui.fres, fsrc: ui.fsrc, oneClick: ui.oneClick, watch: [...watch], pageSize: ui.pageSize, cols: ui.cols, ccy: ui.ccy })); } catch (_) {} };

  /* full-screen loading screen until the markets and your account are ready */
  let fedOk = false, cliOk = false;
  const bootStep = () => { $('#bootMsg').textContent = !fedOk ? 'Loading markets…' : !cliOk ? 'Connecting to your account…' : 'Preparing your workspace…'; };
  try { await Promise.all([Feed.init().then(() => { fedOk = true; bootStep(); }), Client.start().then(() => { cliOk = true; bootStep(); })]); } catch (e) {
    $('#boot').classList.add('err'); $('#bootMsg').textContent = '';
    $('#boot .boot-box').insertAdjacentHTML('beforeend', `<div class="boot-err">Couldn't load the trading screen. Check your internet connection and try again.<small>${esc(e.message)}</small><button class="btn pri" onclick="location.reload()">Retry</button></div>`);
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
    layout: { background: { color: '#1b1d22' }, textColor: '#8a929b', fontSize: 12 },
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
  const mainSeries = () => ui.fsrc === 'funding' && !optView() ? lineS : candles; // funding rate is drawn as a line
  /* charts follow Delta. Options: Traded Price | Mark Price | <underlying> Chart (the index) | Depth.
     Futures: Traded Price | Mark Price | Funding | Depth */
  const FUT_RES = ['5s', '15s', '30s', '1m', '5m', '15m', '1h', '4h', '1d', '3m'];
  const OPT_RES = ['1m', '5m', '10m', '15m', '1h', '4h', '1d', '1w', '2w', '3m'];
  const resLbl = (r) => r.replace(/d$/, 'D').replace(/w$/, 'W');
  const optView = () => ui.view === 'options';
  const curRes = () => optView() ? ui.ores : ui.fres;
  const curSrc = () => optView() ? ui.osrc : ui.fsrc;
  const srcSym = () => { const src = curSrc(), p = P(); return src === 'mark' ? 'MARK:' + ui.sym : src === 'funding' ? 'FUNDING:' + ui.sym : src === 'index' ? (p.index || p.under + 'USD') : ui.sym; };
  const srcName = () => curSrc() === 'mark' ? 'MARK' + ui.sym : srcSym();
  let allData = [], volBy = {}, lastCandle = null, loadTok = 0, lines = [], loadingMore = false, noMore = false, loadedKey = '';
  const volColor = (c) => c.close >= c.open ? '#00b38655' : '#f6465d55';

  function setAll(data) {
    allData = data; volBy = {}; data.forEach(c => volBy[c.time] = c.volume);
    candles.setData(data); lineS.setData(data.map(c => ({ time: c.time, value: c.close }))); vol.setData(data.map(c => ({ time: c.time, value: c.volume, color: volColor(c) })));
  }
  function showLegend(c) {
    const lg = $('#legend'), p = P();
    const name = `${esc(srcName())} · ${resLbl(curRes())} · Delta`;
    if (!c) { lg.innerHTML = `<b>${name}</b> <span class="mut">· no trades in this range</span>`; return; }
    if (curSrc() === 'funding') { lg.innerHTML = `<b>${name}</b> <span>Funding <b class="${cls(c.close)}">${c.close.toFixed(4)}%</b></span>`; return; }
    const ch = c.open ? (c.close - c.open) / c.open * 100 : 0, k = cls(ch), d = curSrc() === 'index' ? 1 : p.dp;
    lg.innerHTML = `<b>${name}</b> <span>O <b class="${k}">${fmt(c.open, d)}</b> H <b class="${k}">${fmt(c.high, d)}</b> L <b class="${k}">${fmt(c.low, d)}</b> C <b class="${k}">${fmt(c.close, d)}</b> <b class="${k}">${sgn(ch)}%</b></span>${curSrc() === 'traded' ? ` <span class="mut">Vol <b>${compact(c.volume || 0)}</b></span>` : ''}`;
  }
  chart.subscribeCrosshairMove((param) => {
    const d = param.time && param.seriesData && param.seriesData.get(candles);
    showLegend(d ? { ...d, volume: volBy[param.time] } : lastCandle);
  });

  async function loadCandles() {
    const tok = ++loadTok, p = P(), idx = curSrc() === 'index', fund = curSrc() === 'funding'; loadedKey = chartKey();
    const pf = { priceFormat: fund ? { type: 'price', precision: 4, minMove: 0.0001 } : { type: 'price', precision: idx ? 1 : p.dp, minMove: idx ? 0.1 : p.tick } };
    candles.applyOptions({ visible: !fund }); lineS.applyOptions({ visible: fund });
    vol.applyOptions({ visible: false }); // Delta's chart shows volume in the legend only
    candles.applyOptions(pf); lineS.applyOptions(pf);
    noMore = false; loadingMore = false;
    const data = await Feed.candles(srcSym(), curRes()).catch(() => []);
    if (tok !== loadTok) return;
    setAll(data); lastCandle = data[data.length - 1] || null;
    const n = data.length; if (n) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 110), to: n + 8 });
    showLegend(lastCandle); refreshLines();
  }
  async function loadMore() {
    if (loadingMore || noMore || !allData.length) return;
    loadingMore = true; const tok = loadTok, first = allData[0].time;
    const more = await Feed.candles(srcSym(), curRes(), first - 1).catch(() => []);
    loadingMore = false; if (tok !== loadTok) return;
    const fresh = more.filter(c => c.time < first);
    if (!fresh.length) { noMore = true; return; }
    const r = chart.timeScale().getVisibleLogicalRange();
    setAll([...fresh, ...allData]); lastCandle = allData[allData.length - 1];
    if (r) chart.timeScale().setVisibleLogicalRange({ from: r.from + fresh.length, to: r.to + fresh.length });
  }
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r && r.from < 15) loadMore(); });

  const chartKey = () => ui.sym + '|' + curRes() + '|' + curSrc();
  /* mark-price and index charts move with the ticker rather than with trades */
  function tickChart(px, ts) {
    if (!px || !lastCandle || !allData.length || curSrc() === 'depth') return;
    const step = Feed.RES[curRes()] || 3600, b = Math.floor(ts / step) * step;
    if (b > lastCandle.time) { lastCandle = { time: b, open: px, high: px, low: px, close: px, volume: 0 }; allData.push(lastCandle); }
    else if (b < lastCandle.time) return;
    lastCandle.high = Math.max(lastCandle.high, px); lastCandle.low = Math.min(lastCandle.low, px); lastCandle.close = px;
    candles.update(lastCandle); lineS.update({ time: lastCandle.time, value: px });
  }
  Feed.on('ticker', (s) => {
    if (s !== ui.sym || (optView() && ui.optMode !== 'chart')) return;
    const t = T(); if (curSrc() === 'mark') tickChart(t.mark, Date.now() / 1000); else if (curSrc() === 'index') tickChart(Engine.spotOf(ui.sym), Date.now() / 1000);
  });
  Feed.on('trade', (s, tr) => {
    if (s !== ui.sym || curSrc() !== 'traded') return;
    const step = Feed.RES[curRes()], b = Math.floor(tr.ts / step) * step;
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
      add(pos.tp, '#00b386', 'TP'); add(pos.sl, '#f6465d', 'SL');
    }
    for (const o of a.orders) if (o.symbol === ui.sym) add(o.price || o.stop, '#7f8790', `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.size - o.filled}${o.stop ? ' stop' : ''}`);
  }

  function buildChartBar() {
    const tools = $('#chartTools');
    tools.classList.add('optbar');
    const oneClk = `<label class="oneclk">1-Click Trade<input type="checkbox" id="ocTog" ${ui.oneClick ? 'checked' : ''}><i></i></label>`;
    if (!optView()) {
      const FSRC = [['traded', 'Traded Price'], ['mark', 'Mark Price'], ['funding', 'Funding'], ['depth', 'Depth']];
      tools.innerHTML = `<div class="trow tabs2">${FSRC.map(([k, l]) => `<a data-src="${k}" class="${k === ui.fsrc ? 'on' : ''}">${l}</a>`).join('')}</div>
        <div class="trow">${ui.fsrc === 'depth' ? '' : `<div class="resbar">${FUT_RES.map(r => `<button data-r="${r}" class="${r === ui.fres ? 'on' : ''}">${resLbl(r)}</button>`).join('')}</div>`}<div class="sp"></div>${oneClk}</div>`;
      return;
    }
    const p = P(), rows = Feed.chain(p.under, p.expiry), ex = Feed.expiries(p.under), d6 = (e) => { const d = new Date(e); return z2(d.getDate()) + z2(d.getMonth() + 1) + String(d.getFullYear()).slice(2); };
    const sel = (k, opts, v) => `<select class="csel" data-cs="${k}">${opts.map(([val, l]) => `<option value="${val}"${String(val) === String(v) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    const SRC = [['traded', 'Traded Price'], ['mark', 'Mark Price'], ['index', esc(p.under) + ' Chart'], ['depth', 'Depth']];
    tools.innerHTML = `<div class="trow crow1">${modeSeg()}
        ${sel('kind', [['call', 'C'], ['put', 'P']], p.kind)}${sel('under', unders().map(u => [u, u]), p.under)}
        ${sel('strike', rows.map(r => [r.strike, r.strike]), p.strike)}${sel('expiry', ex.map(e => [e, d6(e)]), p.expiry)}<span class="levb">${p.maxLev}x</span></div>
      <div class="trow tabs2">${SRC.map(([k, l]) => `<a data-src="${k}" class="${k === ui.osrc ? 'on' : ''}">${l}</a>`).join('')}</div>
      <div class="trow">${ui.osrc === 'depth' ? '' : `<div class="resbar">${OPT_RES.map(r => `<button data-r="${r}" class="${r === ui.ores ? 'on' : ''}">${resLbl(r)}</button>`).join('')}</div>`}<div class="sp"></div>
        ${oneClk}</div>`;
  }
  // Option Chain: a spine with bars either side; Chart: two candlesticks (drawn to match Delta's toggle)
  const IC_CHAIN = '<svg class="mic" viewBox="0 0 18 18" fill="currentColor"><rect x="8.2" y="2" width="1.6" height="14" rx=".8"/><rect x="2" y="3.6" width="4.6" height="1.6" rx=".8"/><rect x="11.4" y="3.6" width="4.6" height="1.6" rx=".8"/><rect x="2" y="8.2" width="14" height="1.6" rx=".8"/><rect x="2" y="12.8" width="4.6" height="1.6" rx=".8"/><rect x="11.4" y="12.8" width="4.6" height="1.6" rx=".8"/></svg>';
  const IC_CHART = '<svg class="mic" viewBox="0 0 18 18" fill="currentColor"><rect x="4.7" y="3.5" width="1.6" height="12" rx=".8"/><rect x="2.8" y="6" width="5.4" height="7" rx="1"/><rect x="11.7" y="1.8" width="1.6" height="12" rx=".8"/><rect x="9.8" y="4.2" width="5.4" height="7" rx="1"/></svg>';
  const modeSeg = () => `<div class="mseg"><button data-m="chain" class="${ui.optMode === 'chain' ? 'on' : ''}">${IC_CHAIN}Option Chain</button><button data-m="chart" class="${ui.optMode === 'chart' ? 'on' : ''}">${IC_CHART}Chart</button></div>`;
  const setMode = (m) => { if (m && m !== ui.optMode) { ui.optMode = m; applyView(); } };
  $('#chartTools').onclick = (e) => {
    const m = e.target.closest('[data-m]'); if (m) return setMode(m.dataset.m);
    const r = e.target.dataset.r; if (r) { if (optView()) ui.ores = r; else ui.fres = r; saveUi(); buildChartBar(); loadCandles(); return; }
    const src = e.target.closest('[data-src]'); if (src) { if (optView()) ui.osrc = src.dataset.src; else ui.fsrc = src.dataset.src; saveUi(); buildChartBar(); showChartSrc(); return; }
  };
  // contract pickers: C/P, underlying, strike, expiry
  $('#chartTools').addEventListener('change', (e) => {
    if (e.target.id === 'ocTog') { ui.oneClick = e.target.checked; saveUi(); showChartSrc(); return; }
    const k = e.target.dataset.cs; if (!k) return;
    const p = P(), v = e.target.value;
    const under = k === 'under' ? v : p.under, ex = Feed.expiries(under), expiry = k === 'expiry' ? +v : (ex.includes(p.expiry) ? p.expiry : ex[0]);
    const rows = Feed.chain(under, expiry), kind = k === 'kind' ? v : p.kind;
    const want = k === 'strike' ? +v : p.strike, row = rows.reduce((b, x) => (!b || Math.abs(x.strike - want) < Math.abs(b.strike - want) ? x : b), null);
    const s2 = row && (row[kind] || row.call || row.put); if (s2) selectSymbol(s2);
  });
  /* Depth tab: cumulative bids / asks drawn on a canvas instead of candles */
  function showChartSrc() {
    const depth = curSrc() === 'depth';
    $('#chart').classList.toggle('hidden', depth); $('#depth').classList.toggle('hidden', !depth); $('#legend').classList.toggle('hidden', depth);
    $('#oneClick').classList.toggle('hidden', !(ui.oneClick && !depth));
    if (depth) drawDepth(); else if (loadedKey !== chartKey()) loadCandles();
  }
  function drawDepth() {
    const cv = $('#depth'), b = Feed.books[ui.sym], p = P(); if (!cv || cv.classList.contains('hidden')) return;
    const w = cv.clientWidth, h = cv.clientHeight, r = window.devicePixelRatio || 1; cv.width = w * r; cv.height = h * r;
    const g = cv.getContext('2d'); g.scale(r, r); g.clearRect(0, 0, w, h);
    if (!b || !b.bids.length || !b.asks.length) { g.fillStyle = '#7f8790'; g.fillText('Loading order book…', 20, 30); return; }
    const lo = b.bids[b.bids.length - 1].p, hi = b.asks[b.asks.length - 1].p, maxD = Math.max(b.bids[b.bids.length - 1].d, b.asks[b.asks.length - 1].d);
    const pad = 46, X = (v) => (v - lo) / ((hi - lo) || 1) * (w - pad) , Y = (d) => h - 24 - d / maxD * (h - 50);
    const side = (lv, col, fill) => {
      g.beginPath(); g.moveTo(X(lv[0].p), h - 24);
      for (const l of lv) { g.lineTo(X(l.p), Y(l.d - l.s)); g.lineTo(X(l.p), Y(l.d)); }
      g.lineTo(X(lv[lv.length - 1].p), h - 24); g.closePath(); g.fillStyle = fill; g.fill(); g.strokeStyle = col; g.lineWidth = 1.5; g.stroke();
    };
    side(b.bids, '#24b47e', '#24b47e33'); side(b.asks, '#ef5a5a', '#ef5a5a33');
    g.fillStyle = '#7f8790'; g.font = '11px Inter, Segoe UI, sans-serif';
    for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; g.fillText(v.toFixed(p.dp), Math.min(X(v), w - pad - 30), h - 8); const d = maxD * i / 4; g.fillText((d * p.cv).toFixed(decOf(p.cv)), w - pad + 4, Y(d) + 4); }
  }
  /* 1-Click Trade (Delta's chart overlay): Sell at the bid / Buy at the ask, market order of the shown lots */
  function renderOneClick() {
    const el = $('#oneClick'); if (!el || el.classList.contains('hidden')) return;
    const t = T(), p = P();
    if (!el.firstChild) el.innerHTML = '<button class="s" data-oc="sell"><b></b>SELL</button><input id="ocQty" inputmode="numeric"><button class="b" data-oc="buy"><b></b>BUY</button>';
    el.querySelector('.s b').textContent = t.bid ? t.bid.toFixed(p.dp) : '--'; el.querySelector('.b b').textContent = t.ask ? t.ask.toFixed(p.dp) : '--';
    const q = $('#ocQty'); if (document.activeElement !== q) q.value = ui.ocQty;
  }
  $('#oneClick').addEventListener('input', (e) => { if (e.target.id === 'ocQty') ui.ocQty = Math.max(1, parseInt(e.target.value, 10) || 1); });
  $('#oneClick').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-oc]'); if (!b) return;
    const r = await Engine.place(Engine.active, { symbol: ui.sym, side: b.dataset.oc, type: 'market', size: String(ui.ocQty) });
    if (!r.ok) toast('error', r.error);
  });

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
    ui.f.price = ui.f.stop = ui.f.tp = ui.f.sl = ''; ui.f.size = ui.f.qty = ''; ui.lev.open = false; ui.ddOpen = false;
    applyView(); updateInterest(); renderOrderPanel(); if (isMob()) applyMobile(); dirty(true);
  }
  function applyView() {
    const opt = ui.view === 'options', chain = opt && ui.optMode === 'chain';
    [...$('#nav').children].forEach(a => a.classList.toggle('on', a.dataset.view === ui.view));
    document.body.classList.toggle('optv', opt);
    $('#chain').classList.toggle('hidden', !chain);
    $('#chartWrap').classList.toggle('hidden', chain); $('#chartTools').classList.toggle('hidden', chain);
    buildChartBar(); renderSymBtn();
    if (chain) { renderChainBar(); renderChainTbl(true); }
    else if (ui.sym && loadedKey !== chartKey()) loadCandles(); else refreshLines();
    showChartSrc();
    if (!chain) Feed.setChain([]);
  }
  $('#nav').onclick = (e) => { const v = e.target.dataset.view; if (v && v !== ui.view) setView(v); };

  /* ================= futures market picker (Delta's side panel) ================= */
  function renderSymBtn() {
    const p = P(); if (!p) return;
    if (p.kind !== 'perp') { $('#symBtn').textContent = p.symbol; return; }
    $('#symBtn').innerHTML = `<span class="star ${watch.has(p.symbol) ? 'on' : ''}" data-w="${p.symbol}">${watch.has(p.symbol) ? '★' : '☆'}</span><b>${esc(p.symbol)}</b><span class="car">⌄</span>`;
  }
  const PICK_TABS = [['watch', 'Watchlist'], ['futures', 'Futures'], ['rwa', 'RWA Tokens']];
  function renderPicker() {
    const el = $('#symPicker'); if (el.classList.contains('hidden')) return;
    if (!$('#pkList')) {
      el.innerHTML = `<div class="pk-tabs" id="pkTabs"></div><div class="pk-bar"><div class="dinp pk-q"><input id="symSearch" placeholder="Search" autocomplete="off"></div><a class="pk-oc" data-oc="1">Go to Options Chain ›</a></div>
        <div class="pk-head"><span>Contract</span><span>Last Price</span><span>24h Chg.</span><span>24h Vol.</span></div><div class="pk-list" id="pkList"></div>`;
      $('#symSearch').oninput = renderPicker;
    }
    $('#pkTabs').innerHTML = PICK_TABS.map(([k, l]) => `<a data-pt="${k}" class="${k === ui.pickTab ? 'on' : ''}">${l}</a>`).join('');
    const list = marketList(ui.pickTab, $('#symSearch').value);
    $('#pkList').innerHTML = list.map(x => {
      const p = Feed.products[x], t = Feed.tickers[x] || {}, ch = t.open ? (t.last - t.open) / t.open * 100 : 0;
      return `<div class="pk-row ${x === ui.sym ? 'on' : ''}" data-s="${x}"><span class="pk-c"><span class="star ${watch.has(x) ? 'on' : ''}" data-w="${x}">${watch.has(x) ? '★' : '☆'}</span>
          <span><b>${esc(x)}</b> <i class="levb">${p.maxLev}x</i><small>${esc(p.shortDesc || p.desc)}</small></span></span>
        <span>${usd(t.last, p.dp)}</span><span class="${cls(ch)}">${ch.toFixed(2)}%</span><span>$${compact(t.volUsd || 0)}</span></div>`;
    }).join('') || `<div class="empty">${ui.pickTab === 'watch' ? 'Tap ☆ on a market to add it to your watchlist' : 'No markets found'}</div>`;
  }
  function marketList(tab, q) {
    q = (q || '').trim().toLowerCase();
    return Feed.symbols.filter(x => { const p = Feed.products[x]; return tab === 'watch' ? watch.has(x) : tab === 'rwa' ? p.tradfi : true; })
      .filter(x => !q || x.toLowerCase().includes(q) || (Feed.products[x].shortDesc || '').toLowerCase().includes(q))
      .sort((a, b) => ((Feed.tickers[b] || {}).volUsd || 0) - ((Feed.tickers[a] || {}).volUsd || 0)).slice(0, 200);
  }
  const togglePicker = (show) => { const el = $('#symPicker'); el.classList.toggle('hidden', !show); if (show) { renderPicker(); $('#symSearch').value = ''; renderPicker(); $('#symSearch').focus(); } };
  const toggleWatch = (x) => { if (watch.has(x)) watch.delete(x); else watch.add(x); saveUi(); renderSymBtn(); renderPicker(); };
  $('#symBtn').onclick = (e) => {
    if (ui.view !== 'futures') return; e.stopPropagation();
    const w = e.target.closest('[data-w]'); if (w) return toggleWatch(w.dataset.w);
    togglePicker($('#symPicker').classList.contains('hidden'));
  };
  $('#symPicker').onclick = (e) => {
    e.stopPropagation();
    const w = e.target.closest('[data-w]'); if (w) return toggleWatch(w.dataset.w);
    const t = e.target.closest('[data-pt]'); if (t) { ui.pickTab = t.dataset.pt; return renderPicker(); }
    if (e.target.closest('[data-oc]')) { togglePicker(false); return setView('options'); }
    const r = e.target.closest('.pk-row'); if (r) { togglePicker(false); selectSymbol(r.dataset.s); }
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('#symPicker') && !e.target.closest('#symBtn')) togglePicker(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') togglePicker(false); });

  function selectSymbol(s, opts = {}) {
    const p = Feed.products[s]; if (!p) return;
    const prevView = ui.view;
    if (p.kind === 'perp') { ui.perp = s; if (ui.view !== 'futures') { ui.view = 'futures'; } }
    else { ui.opt = s; ui.under = p.under; ui.expiry = p.expiry; if (ui.view !== 'options') ui.view = 'options'; }
    ui.sym = s; saveUi();
    ui.f.price = ui.f.stop = ui.f.tp = ui.f.sl = ''; ui.f.size = ui.f.qty = ''; ui.lev.open = false; ui.ddOpen = false;
    if (opts.price) { ui.f.price = String(opts.price); ui.otype = 'limit'; }
    if (opts.side) ui.side = opts.side;
    updateInterest(); renderSymBtn(); renderOrderPanel(); ui.cdOpen = false;
    if (!(ui.view === 'options' && ui.optMode === 'chain')) { loadCandles(); buildChartBar(); showChartSrc(); }
    if (prevView !== ui.view) applyView(); else applyViewLight(); // switching futures <-> options re-lays out the panels
    dirty(true);
  }
  function applyViewLight() { [...$('#nav').children].forEach(a => a.classList.toggle('on', a.dataset.view === ui.view)); document.body.classList.toggle('optv', ui.view === 'options'); }
  function updateInterest() {
    const set = new Set([ui.sym]);
    for (const a of Engine.state.accounts) { Object.keys(a.positions).forEach(s => set.add(s)); a.orders.forEach(o => set.add(o.symbol)); }
    Feed.setInterest([...set]);
  }

  /* ================= options chain ================= */
  let chainKey = '', chainSyms = '';
  /* Delta's chain: calls | strike | puts. Each side scrolls sideways on its own (calls start scrolled to the strike),
     all three scroll vertically together. Columns are listed from the strike outward. */
  const COLS = {
    call: ['oi', 'aq', 'ask', 'mk', 'bid', 'bq', 'delta', 'vol', 'oi6h', 'pos', 'gamma', 'vega', 'theta', 'chg', 'last', 'open', 'high', 'low'],
    put: ['oi', 'bq', 'bid', 'mk', 'ask', 'aq', 'delta', 'vol', 'oi6h', 'pos', 'gamma', 'vega', 'theta', 'chg', 'last', 'open', 'high', 'low'],
  };
  const PV = '<small>(Price / IV)</small>';
  const MCOLS = { price: ['mk', 'ba'], oivol: ['oi', 'vol'], greeks: ['delta', 'gamma'] }; // from the strike outward
  const CDEF = {
    ba: { h: '<span class="buy">BID</span><span class="sell">ASK</span>', g: 'ba', w: 'p' },
    oi: { h: 'OI', g: 'oi' }, aq: { h: 'Ask Qty', u: 1, g: 'qty' }, bq: { h: 'Bid Qty', u: 1, g: 'qty' },
    ask: { h: 'Ask' + PV, g: 'ba', w: 'p' }, bid: { h: 'Bid' + PV, g: 'ba', w: 'p' }, mk: { h: 'Mark' + PV, g: 'mark', w: 'p' },
    delta: { h: 'Delta' }, vol: { h: 'Volume' }, oi6h: { h: '6H OI Chg.' }, pos: { h: 'POS', u: 1 }, gamma: { h: 'Gamma' }, vega: { h: 'Vega' },
    theta: { h: 'Theta' }, chg: { h: '24hr Chg.' }, last: { h: 'Last' }, open: { h: 'Open' }, high: { h: 'High' }, low: { h: 'Low' },
  };
  // column picker (Delta's settings icon): Bid/Ask with its Qty and Mark sub-options, then one box per column
  const PICK = [['oi', 'OI'], ['ba', 'Bid/ Ask', [['qty', 'Qty'], ['mark', 'Mark']]], ['delta', 'Delta'], ['vol', 'Volume'], ['oi6h', '6H OI Chg.'], ['pos', 'POS'],
    ['gamma', 'Gamma'], ['vega', 'Vega'], ['theta', 'Theta'], ['chg', '24h Chg.'], ['last', 'Last'], ['open', 'Open'], ['high', 'High'], ['low', 'Low']];
  const colOn = (k) => { const g = CDEF[k].g || k; return !hiddenCols.has(g) && !((g === 'qty' || g === 'mark') && hiddenCols.has('ba')); };
  function renderChainBar() {
    if (!$('#cbar')) {
      $('#chain').innerHTML = `<div class="cbar" id="cbar"></div><div class="cinfo" id="cinfo"></div><div class="cpop hidden" id="cpop"></div>
        <div class="cbody"><div class="cside calls" id="cC"><table class="ctbl" id="tC"></table></div><div class="cstk" id="cS"><table class="ctbl" id="tS"></table></div><div class="cside puts" id="cP"><table class="ctbl" id="tP"></table></div></div>`;
      const C = $('#cC'), S = $('#cS'), Pp = $('#cP');
      Pp.onscroll = () => { C.scrollTop = S.scrollTop = Pp.scrollTop; };
      // as on Delta: scrolling the calls sideways mirrors the puts (calls away from the strike = puts away from it)
      C.addEventListener('scroll', () => { Pp.scrollLeft = (C.scrollWidth - C.clientWidth) - C.scrollLeft; });
      [C, S].forEach(el => el.addEventListener('wheel', (e) => { if (e.deltaY) { Pp.scrollTop += e.deltaY; e.preventDefault(); } }, { passive: false }));
      // hover highlights the whole strike row across the three tables
      $('#chain').addEventListener('mouseover', (e) => {
        const tr = e.target.closest('.cbody tbody tr'); const i = tr ? [...tr.parentNode.children].indexOf(tr) : -1;
        if (i === hoverRow) return; hoverRow = i;
        ['#tC', '#tS', '#tP'].forEach(id => $(id).querySelectorAll('tbody tr').forEach((r, j) => r.classList.toggle('hov', j === i)));
      });
    }
    const ex = ensureExpiry();
    const yy = (e) => `${z2(new Date(e).getDate())} ${MON[new Date(e).getMonth()]} ${String(new Date(e).getFullYear()).slice(2)}`;
    if (isMob()) {
      $('#cbar').innerHTML = `<div class="crow"><div class="unds">${unders().map(u => `<button data-u="${u}" class="${u === ui.under ? 'on' : ''}">${u}</button>`).join('')}</div></div>
        <div class="crow"><select class="csel" id="mExp">${ex.map(e => `<option value="${e}"${e === ui.expiry ? ' selected' : ''}>${yy(e)}</option>`).join('')}</select><span class="mexp"><small>Expires in</small><b>${ttl(ui.expiry).replace(/^0d:/, '')}</b></span></div>`;
      $('#mExp').onchange = (e) => { ui.expiry = +e.target.value; ui.opt = pickAtm(); selectSymbol(ui.opt); renderChainBar(); renderChainTbl(true); };
      chainKey = ''; return;
    }
    $('#cbar').innerHTML = `<div class="crow">${modeSeg()}<div class="unds">${unders().map(u => `<button data-u="${u}" class="${u === ui.under ? 'on' : ''}">${u}</button>`).join('')}</div></div>
      <div class="crow"><div class="exps" id="exps">${ex.map(e => `<button data-e="${e}" class="${e === ui.expiry ? 'on' : ''}">${yy(e)}</button>`).join('')}</div>
        <button class="arr" data-sc="-1">‹</button><button class="arr" data-sc="1">›</button>
        <button class="arr ico" data-pop="cols" title="Columns">⚙</button><button class="arr ico" data-pop="more" title="More">⋮</button></div>`;
    chainKey = '';
  }
  let hoverRow = -1, chainCalls = null;
  function renderPop(kind) {
    const el = $('#cpop');
    if (!kind) { el.classList.add('hidden'); el.dataset.k = ''; return; }
    el.dataset.k = kind; el.classList.remove('hidden');
    const box = (k, l, sub) => `<label class="pk ${sub ? 'sub' : ''}"><input type="checkbox" data-col="${k}" ${hiddenCols.has(k) ? '' : 'checked'}>${l}</label>`;
    el.className = 'cpop ' + kind;
    el.innerHTML = kind === 'more' ? '<a href="https://www.delta.exchange/app/expired_futures_and_options" target="_blank" rel="noopener">Settlement Prices</a>'
      : `<div class="pcol">${PICK.slice(0, 7).map(([k, l, subs]) => box(k, l) + (subs || []).map(([sk, sl]) => box(sk, sl, 1)).join('')).join('')}</div><div class="pcol">${PICK.slice(7).map(([k, l]) => box(k, l)).join('')}</div>`;
  }
  function chainCell(k, sym, put, itm, maxOi, sel) {
    const t = Feed.tickers[sym] || {}, p = Feed.products[sym], d = p.dp, cd = decOf(p.cv), g = t.greeks || {};
    const c = `${itm} ${sel} c-${CDEF[k].w || 'n'}`, iv = (v) => v ? (v * 100).toFixed(1) + '%' : '';
    const px = (cl, v, vol) => `<td class="q ${cl} ${c}" data-s="${sym}" data-px="${v ? v.toFixed(d) : ''}">${usd(v, d)}<small>${iv(vol)}</small></td>`;
    const n = (v, txt) => `<td data-s="${sym}" class="${c}">${v ? txt : '-'}</td>`; // every cell selects its contract, as on Delta
    const pos = Engine.active && Engine.active.positions[sym];
    switch (k) {
      case 'oi': return `<td data-s="${sym}" class="oi ${put ? 'p' : 'c'} ${c}">${t.oiUsd ? '$' + compact(t.oiUsd) : '-'}<i style="width:${Math.round((t.oiUsd || 0) / maxOi * 28)}px"></i></td>`;
      case 'aq': return n(t.askSize, (t.askSize * p.cv).toFixed(cd));
      case 'bq': return n(t.bidSize, (t.bidSize * p.cv).toFixed(cd));
      case 'ask': return px('ask', t.ask, t.askIv);
      case 'bid': return px('bid', t.bid, t.bidIv);
      case 'mk': return px('mk', t.mark, t.iv);
      case 'ba': return `<td class="bab ${c}"><span class="q bid" data-s="${sym}" data-px="${t.bid ? t.bid.toFixed(d) : ''}">${usd(t.bid, d)}</span><span class="q ask" data-s="${sym}" data-px="${t.ask ? t.ask.toFixed(d) : ''}">${usd(t.ask, d)}</span></td>`;
      case 'delta': return n(g.delta !== undefined, (g.delta || 0).toFixed(2));
      case 'vol': return n(t.volUsd, '$' + compact(t.volUsd));
      case 'oi6h': return n(t.oiChg6h, '$' + compact(t.oiChg6h));
      case 'pos': return n(pos, pos ? (pos.size * p.cv).toFixed(cd) : '');
      case 'gamma': return n(g.gamma !== undefined, (g.gamma || 0).toFixed(5));
      case 'vega': return n(g.vega !== undefined, (g.vega || 0).toFixed(2));
      case 'theta': return n(g.theta !== undefined, (g.theta || 0).toFixed(2));
      case 'chg': { const ch = t.open && t.last ? (t.last - t.open) / t.open * 100 : null; return `<td data-s="${sym}" class="${c} ${ch === null ? '' : cls(ch)}">${ch === null ? '-' : ch.toFixed(2) + '%'}</td>`; }
      case 'last': return n(t.last, usd(t.last, d));
      case 'open': return n(t.open, (t.open || 0).toFixed(d));
      case 'high': return n(t.high, (t.high || 0).toFixed(d));
      case 'low': return n(t.low, (t.low || 0).toFixed(d));
    }
  }
  function renderChainTbl(scroll) {
    if (ui.view !== 'options' || ui.optMode !== 'chain' || !$('#tC')) return;
    const rows = Feed.chain(ui.under, ui.expiry), spot = Feed.spotOf(ui.under), up = Feed.products[ui.sym] ? ui.sym : '';
    const syms = rows.flatMap(r => [r.call, r.put].filter(Boolean)).join(',');
    if (syms !== chainSyms) { chainSyms = syms; Feed.setChain(syms ? syms.split(',') : []); }
    const maxOi = Math.max(1, ...rows.flatMap(r => [r.call, r.put].map(x => x && Feed.tickers[x] ? Feed.tickers[x].oiUsd || 0 : 0)));
    const mob = isMob(), callCols = mob ? MCOLS[ui.cview].slice().reverse() : COLS.call.filter(colOn).reverse(), putCols = mob ? MCOLS[ui.cview] : COLS.put.filter(colOn);
    const head = (cols) => `<thead><tr>${cols.map(k => `<th class="c-${CDEF[k].w || 'n'}">${CDEF[k].h}${CDEF[k].u ? `<small>${esc(ui.under)}</small>` : ''}</th>`).join('')}</tr></thead><tbody>`;
    let hc = head(callCols), hp = head(putCols), hs = `<thead><tr><th class="hk" data-sort>Strike <span class="srt">⇕</span></th></tr></thead><tbody>`;
    if (ui.strikeDesc) rows.reverse();
    let spotDone = false;
    for (const r of rows) {
      if (!spotDone && spot && (ui.strikeDesc ? r.strike <= spot : r.strike >= spot)) { const sr = '<tr class="spotrow"><td colspan="20"></td></tr>'; hc += sr; hp += sr; hs += `<tr class="spotrow"><td><span class="spill">${esc(ui.under)} ${num1(spot, 1)}</span></td></tr>`; spotDone = true; }
      const cSel = up && r.call === up, pSel = up && r.put === up;
      const side = (sym, put, itm, cols, sel) => sym ? cols.map(k => chainCell(k, sym, put, itm ? 'itm' : '', maxOi, sel ? 'sel' : '')).join('') : `<td colspan="${cols.length}" class="mut">—</td>`;
      hc += `<tr class="${cSel ? 'selrow' : ''}">${side(r.call, false, r.strike < spot, callCols, cSel)}</tr>`;
      hp += `<tr class="${pSel ? 'selrow' : ''}">${side(r.put, true, r.strike > spot, putCols, pSel)}</tr>`;
      hs += `<tr class="${cSel || pSel ? 'selrow' : ''}"><td class="strike" data-c="${r.call || ''}" data-p="${r.put || ''}">${r.strike}</td></tr>`;
    }
    $('#tC').innerHTML = hc + '</tbody>'; $('#tP').innerHTML = hp + '</tbody>'; $('#tS').innerHTML = hs + '</tbody>';
    if (hoverRow >= 0) ['#tC', '#tS', '#tP'].forEach(id => { const r = $(id).querySelectorAll('tbody tr')[hoverRow]; if (r) r.classList.add('hov'); });
    if (mob) $('#cinfo').innerHTML = `<span>Calls</span><span class="cview">${[['price', 'Price'], ['oivol', 'OI/Vol'], ['greeks', 'Greeks']].map(([k, l]) => `<a data-cv="${k}" class="${k === ui.cview ? 'on' : ''}">${l}</a>`).join('')}</span><span class="r">Puts</span>`;
    else $('#cinfo').innerHTML = `<span>Calls</span><span class="cmid">${esc(ui.under)} <b class="buy">$${num1(spot, 1)}</b><em></em>Time to Expiry <b>${ttl(ui.expiry)}</b></span><span class="r">Puts</span>`;
    const colKey = callCols.join();
    if (chainCalls !== colKey) { chainCalls = colKey; $('#cC').scrollLeft = $('#cC').scrollWidth; } // calls open scrolled to the strike side
    if (scroll || chainKey !== ui.under + ui.expiry) { chainKey = ui.under + ui.expiry; const sr = $('#tP .spotrow'); if (sr) $('#cP').scrollTop = sr.offsetTop - $('#cP').clientHeight / 2; }
  }
  const sideOf = (q) => q.classList.contains('bid') ? 'sell' : q.classList.contains('ask') ? 'buy' : null;
  $('#chain').addEventListener('mousedown', (e) => {
    const pop = e.target.closest('[data-pop]'); if (pop) { renderPop($('#cpop').dataset.k === pop.dataset.pop ? '' : pop.dataset.pop); return; }
    if (e.target.closest('#cpop')) return;
    if ($('#cpop') && $('#cpop').dataset.k) renderPop('');
    const m = e.target.closest('[data-m]'); if (m) return setMode(m.dataset.m);
    const sc = e.target.closest('[data-sc]'); if (sc) { $('#exps').scrollBy({ left: +sc.dataset.sc * 300, behavior: 'smooth' }); return; }
    if (e.target.closest('[data-sort]')) { ui.strikeDesc = !ui.strikeDesc; renderChainTbl(true); return; }
    const u = e.target.closest('[data-u]'); if (u) { ui.under = u.dataset.u; ui.expiry = null; ensureExpiry(); ui.opt = pickAtm(); selectSymbol(ui.opt); renderChainBar(); renderChainTbl(true); return; }
    const ex = e.target.closest('[data-e]'); if (ex) { ui.expiry = +ex.dataset.e; ui.opt = pickAtm(); selectSymbol(ui.opt); renderChainBar(); renderChainTbl(true); return; }
    const cv = e.target.closest('[data-cv]'); if (cv) { ui.cview = cv.dataset.cv; chainCalls = null; renderChainTbl(); return; }
    const q = e.target.closest('.q'); if (q && q.dataset.s) { selectSymbol(q.dataset.s, { price: q.dataset.px || '', side: sideOf(q) }); if (isMob()) setMTab('trade'); else renderChainTbl(); return; }
    // any other cell selects its contract; the strike keeps the call/put you're on
    const cell = e.target.closest('.cbody td[data-s]'); if (cell) { selectSymbol(cell.dataset.s); if (isMob()) setMTab('trade'); else renderChainTbl(); return; }
    const st = e.target.closest('td.strike'); if (st) { const put = P() && P().kind === 'put', s2 = (put ? st.dataset.p : st.dataset.c) || st.dataset.c || st.dataset.p; if (s2) { selectSymbol(s2); renderChainTbl(); } }
  });
  $('#chain').addEventListener('change', (e) => {
    const k = e.target.dataset.col; if (!k) return;
    if (e.target.checked) hiddenCols.delete(k); else hiddenCols.add(k);
    saveUi(); chainCalls = null; renderChainTbl();
  });
  $('#chain').addEventListener('dblclick', (e) => { const q = e.target.closest('td.q'); if (q && q.dataset.s) { selectSymbol(q.dataset.s, { price: q.dataset.px || '', side: sideOf(q) }); ui.optMode = 'chart'; applyView(); } });
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
      const ms = Math.max(0, Engine.nextFunding() - Date.now()), h = Math.floor(ms / 3.6e6), m = Math.floor(ms % 3.6e6 / 6e4), s = Math.floor(ms % 6e4 / 1e3);
      const usdM = (v) => '$' + ((v || 0) / 1e6).toFixed(1) + 'M'; // Delta shows 24h Vol. and OI in millions
      $('#stats').innerHTML = `
        <div class="fpx ${lastDir}"><b>${usd(px, p.dp)}</b><span>${lastDir === 'sell' ? '↓' : '↑'}</span></div>
        <div><small>24h Change</small><span class="${cls(ch)}">${ch.toFixed(2)}%</span></div>
        <div><small class="dl">Index Price</small><span>${num1(Engine.spotOf(ui.sym), 1)}</span></div>
        <div class="st-hl"><small>24h High</small><span>${usd(t.high, p.dp)}</span></div>
        <div class="st-hl"><small>24h Low</small><span>${usd(t.low, p.dp)}</span></div>
        <div><small>24h Vol.</small><span>${usdM(t.volUsd)}</span></div>
        <div><small>OI</small><span>${usdM(t.oiUsd)}</span></div>
        <div><small class="dl">Funding (8h) / Countdown</small><span>${(t.funding * 100).toFixed(4)}% / ${z2(h)}h:${z2(m)}m:${z2(s)}s</span></div>`;
      $('#cdet').innerHTML = `<a class="smore" data-more>⋯</a>${ui.moreOpen ? `<div class="pop spec morepop"><div><span>24h High</span><b>${usd(t.high, p.dp)}</b></div><div><span>24h Low</span><b>${usd(t.low, p.dp)}</b></div></div>` : ''}<a data-cd>Contract Details <span class="car">⌄</span></a>${ui.cdOpen ? cdHtml(p) : ''}`;
      document.title = `${lastDir === 'sell' ? '▼' : '▲'} ${px.toFixed(p.dp)} USD | Trade ${p.shortDesc || p.symbol} Swaps | Delta Demo`;
    } else {
      const g = t.greeks || {}, gk = (k) => g[k] !== undefined ? g[k].toFixed(k === 'gamma' ? 5 : 2) : '--';
      $('#ctrHdr').innerHTML = `<div class="ch1"><span class="star">☆</span><b class="csym">${esc(p.symbol)}</b><span class="sp"></span>
          <span class="hpop"><span class="mut">Delta</span> <b>${g.delta !== undefined ? g.delta.toFixed(2) : '--'}</b><button class="chev ${ui.grkOpen ? 'up' : ''}" data-hp="grk">⌄</button>
            ${ui.grkOpen ? `<div class="pop grk"><div><span>Gamma</span><b>${gk('gamma')}</b></div><div><span>Theta</span><b>${gk('theta')}</b></div><div><span>Vega</span><b>${gk('vega')}</b></div></div>` : ''}</span>
          <span class="hpop lot"><span class="mut">Lot Size</span> <b>${p.cv} ${esc(p.unit || p.base)}</b><button class="chev ${ui.specOpen ? 'up' : ''}" data-hp="spec">⌄</button>
            ${ui.specOpen ? specHtml(p) : ''}</span></div>
        <div class="ch2"><div><small>24h Change</small><b class="${cls(ch)}">${sgn(ch)}%</b></div><div><small>Price</small><b class="${lastDir}">${usd(px, p.dp)}</b></div>
          <div><small class="dl">Index Price</small><b>${num1(Engine.spotOf(ui.sym), 1)}</b></div><div><small>Mark IV</small><b>${t.iv ? (t.iv * 100).toFixed(1) + '%' : '--'}</b></div>
          <div><small>24h Vol.</small><b>$${compact(t.volUsd || 0)}</b></div></div>`;
      const un = ((Feed.products[p.under + 'USD'] || {}).shortDesc || p.under).replace(/s*Perpetual$/i, '');
      document.title = `Trade ${un} ${p.kind === 'call' ? 'Call' : 'Put'} Options Chain | Delta Demo`;
    }
  }

  $('#ctrHdr').onclick = (e) => {
    const b = e.target.closest('[data-hp]'); if (!b) return;
    const k = b.dataset.hp === 'grk' ? 'grkOpen' : 'specOpen', v = !ui[k]; ui.grkOpen = ui.specOpen = false; ui[k] = v; renderStats();
  };
  document.addEventListener('mousedown', (e) => { if ((ui.grkOpen || ui.specOpen) && !e.target.closest('.hpop')) { ui.grkOpen = ui.specOpen = false; renderStats(); } });
  $('#cdet').onclick = (e) => {
    if (e.target.closest('[data-cd]')) { ui.cdOpen = !ui.cdOpen; ui.moreOpen = false; renderStats(); }
    if (e.target.closest('[data-more]')) { ui.moreOpen = !ui.moreOpen; ui.cdOpen = false; renderStats(); }
  };
  document.addEventListener('mousedown', (e) => { if ((ui.cdOpen || ui.moreOpen) && !e.target.closest('#cdet')) { ui.cdOpen = ui.moreOpen = false; renderStats(); } });
  function cdHtml(p) {
    const pct = (v) => +(v * 100).toFixed(4), u = esc(p.unit || p.base), spot = Engine.spotOf(ui.sym) || T().mark;
    const lim = p.notionalLimit && spot ? `${(p.notionalLimit / spot).toFixed(3)} ${u},  ${fmt(p.notionalLimit, 0)} USD` : `${fmt(p.posLimit, 0)} contracts`;
    const rows = [['Type', 'Linear'], ['Lot Size', `${p.cv} ${u}`], ['Effective Settlement Currency', 'INR'], ['Initial Margin', `${pct(p.imr)} %`], ['Max Leverage', `${p.maxLev}x`],
      ['Maintenance Margin', `${pct(p.mmr)} %`], ['Underlying Index', `<span class="acc">${esc(p.index || '-')}</span>`], ['Position Limit', lim], ['Status', 'Operational']];
    return `<div class="pop spec cdpop"><h4>${esc(p.shortDesc || p.symbol)}</h4>${rows.map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join('')}
      <a href="https://www.delta.exchange/contracts" target="_blank" rel="noopener" class="cdbtn">See full contract specifications</a></div>`;
  }
  function specHtml(p) {
    const d = new Date(p.expiry), pct = (v) => +(v * 100).toFixed(4), u = esc(p.unit || p.base);
    const rows = [['Exercise Style', 'Cash-settled European option'], ['Expires at (Local Time)', `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())} ${hhmm(p.expiry)}:00`],
      ['Effective Settlement Currency', 'INR'], ['Initial Margin(Short)', `${pct(p.imr)} % * Index Price<br>+ Option Mark Price`], ['Max Leverage', `${p.maxLev}x`],
      ['Maintenance Margin (Short)', `${pct(p.mmr)} % * Index Price<br>+ Option Mark Price`], ['Underlying Index', esc(p.index || '-')],
      ['Position Limit', `${+(p.posLimit * p.cv).toFixed(4)} ${u},  ${fmt(p.posLimit, 0)} contracts`], ['Status', 'Operational'], ['Max OI Limit', p.maxOi ? `${fmt(p.maxOi, 0)} USD` : '-']];
    return `<div class="pop spec"><h4>${esc(p.under)} ${p.kind === 'call' ? 'Call' : 'Put'}</h4>${rows.map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join('')}
      <a href="https://www.delta.exchange/contracts" target="_blank" rel="noopener" class="cdbtn">See full contract specifications</a></div>`;
  }

  /* ================= order book / trades ================= */
  /* options: Delta shows the book and recent trades stacked, sizes in the underlying (BTC) */
  function renderOptBook() {
    let b = Feed.books[ui.sym];
    const p = P(), t = T(), cd = decOf(p.cv), q = (v) => (v * p.cv).toFixed(cd), unit = esc(p.unit || p.base);
    // build the frame once per contract and only refresh the rows, so each list keeps its scroll position
    if (!$('#obA') || $('#bookView').dataset.sym !== ui.sym) {
      $('#bookView').dataset.sym = ui.sym; ui.obGroup = (p.groups && p.groups[0]) || p.tick; ui.obgOpen = false;
      $('#bookView').innerHTML = `<div class="dob"><div class="dob-h"><span>Order Book</span><span class="obg"><a data-obg id="obG"></a><span id="obGm"></span></span></div>
        <div class="dhd"><span>Price (USD)</span><span>Size (${unit})</span><span>Total (${unit})</span></div>
        <div class="dsc asks" id="obA" data-pin="1"></div><div class="dmid" id="obM"></div><div class="dsc" id="obB"></div></div>
        <div class="dtr"><div class="dob-h"><span>Recent Trades</span></div><div class="dhd"><span>Price (USD)</span><span>Size (${unit})</span><span>Time/Taker</span></div><div class="dsc" id="obT"></div></div>`;
      // asks are listed best-at-bottom, so that list stays pinned to the bottom unless you scroll it up
      $('#obA').onscroll = (e) => { const el = e.target; el.dataset.pin = el.scrollTop + el.clientHeight >= el.scrollHeight - 2 ? '1' : ''; };
    }
    const step = ui.obGroup || p.tick, gd = decOf(step), groups = p.groups || [p.tick];
    $('#obG').innerHTML = `${step} <span class="car">▾</span>`;
    $('#obGm').innerHTML = ui.obgOpen ? `<div class="pop obgm">${groups.map(m => `<a data-obm="${m}" class="${m === step ? 'on' : ''}">${m}</a>`).join('')}</div>` : '';
    if (b) b = groupBook(b, step, p.tick);
    if (b) {
      const maxD = Math.max(b.asks.length ? b.asks[b.asks.length - 1].d : 1, b.bids.length ? b.bids[b.bids.length - 1].d : 1);
      const row = (l, c) => `<div class="drow ${c}" data-p="${l.p}"><span class="${c === 'a' ? 'sell' : 'buy'}">${l.p.toFixed(Math.max(p.dp, gd))}</span><span>${q(l.s)}</span><span class="tot"><i style="width:${l.d / maxD * 100}%"></i><b>${q(l.d)}</b></span></div>`;
      const A = $('#obA'); A.innerHTML = b.asks.slice().reverse().map(l => row(l, 'a')).join(''); if (A.dataset.pin) A.scrollTop = A.scrollHeight;
      $('#obB').innerHTML = b.bids.map(l => row(l, 'b')).join('');
    } else $('#obA').innerHTML = '<div class="empty">Loading order book…</div>';
    $('#obM').innerHTML = `<b class="${lastDir}">${usd(t.last || t.mark, p.dp)}</b><span class="mk"><i>M</i><u>${(t.mark || 0).toFixed(p.dp)}</u></span>`;
    $('#obT').innerHTML = (Feed.trades[ui.sym] || []).map(x => `<div class="drow"><span class="${x.side}">${x.price.toFixed(p.dp)} ${x.side === 'buy' ? '↗' : '↙'}</span><span>${q(x.size)}</span><span class="mut">${new Date(x.ts * 1000).toLocaleTimeString([], { hour12: false })} /${x.side === 'buy' ? 'B' : 'S'}</span></div>`).join('') || '<div class="empty">No recent trades</div>';
  }
  /* bucket levels by price step (Delta's price_clubbing_values): asks round up, bids round down, totals re-accumulated */
  function groupBook(b, step, tick) {
    if (step <= tick + 1e-12) return b;
    const agg = (lv, up) => {
      const m = new Map();
      for (const l of lv) { const k = +((up ? Math.ceil(l.p / step - 1e-9) : Math.floor(l.p / step + 1e-9)) * step).toFixed(8); m.set(k, (m.get(k) || 0) + l.s); }
      let d = 0; return [...m].map(([p, s]) => ({ p, s, d: (d += s) }));
    };
    return { asks: agg(b.asks, true), bids: agg(b.bids, false) };
  }
  $('#bookView').addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-obg]')) { ui.obgOpen = !ui.obgOpen; renderOptBook(); return; }
    const m = e.target.closest('[data-obm]'); if (m) { ui.obGroup = +m.dataset.obm; ui.obgOpen = false; renderOptBook(); return; }
    if (ui.obgOpen && !e.target.closest('.obg')) { ui.obgOpen = false; renderOptBook(); }
  });
  const renderBook = () => renderOptBook();
  $('#bookView').onclick = (e) => { const r = e.target.closest('.drow[data-p]'); if (!r) return; setField('price', r.dataset.p); };

  /* ================= order panel (Delta's form for options and futures) ================= */
  const renderOrderPanel = () => { if (P()) renderOptOrder(); };
  function setField(k, v) { ui.f[k] = String(v); const id = { price: '#fPrice', stop: '#fStop' }[k]; if (id && $(id)) $(id).value = ui.f[k]; if (k === 'price' && ui.otype === 'market') { ui.otype = 'limit'; renderOrderPanel(); } dirty(); }

  function refPrice(side) {
    const t = T(), ty = ui.otype;
    if ((ty === 'limit' || ty === 'stop_limit' || ty === 'tp_limit') && +ui.f.price > 0) return +ui.f.price;
    if (ty.startsWith('stop') && +ui.f.stop > 0) return +ui.f.stop;
    return (side === 'sell' ? t.bid : t.ask) || t.last || t.mark || 0;
  }
  function maxSize(side = 'buy') {
    const a = Engine.active, p = P(), pos = a.positions[ui.sym], px = refPrice(side);
    if (!px) return 0;
    const per = Engine.marginUnit(ui.sym, side, px, Engine.levOf(a, ui.sym)) + Engine.feeUnit(ui.sym, px, 'taker');
    const avail = Math.max(0, Engine.summary(a).available);
    return Math.min(p.posLimit, Math.floor(avail / per) + (pos ? Math.abs(pos.size) : 0));
  }
  const updateOrderDyn = () => updateOptDyn();

  /* ---- order form, laid out like Delta's ---- */
  const OTYPES = [['stop_limit', 'Stop Limit'], ['tp_limit', 'Take Profit Limit']];
  const LEVS = [1, 2, 5, 10, 25, 50, 100, 200];
  const levSteps = (p) => (p.levSlider || LEVS).filter(x => x <= p.maxLev); // Delta's leverage_slider_values
  /* Delta risk limits: max leverage is allowed up to max_leverage_notional; above that the initial margin % grows by
     initial_margin_scaling_factor per USD of notional (user guide, "Risk Limits"). */
  const maxPosAt = (p, lev) => p.maxLevNotional + (p.imScale ? Math.max(0, 100 / lev - 100 / p.maxLev) / p.imScale : 0);
  function renderOptOrder() {
    const p = P(), a = Engine.active, f = ui.f, ty = ui.otype, sd = ui.side, lev = Engine.levOf(a, ui.sym), L = ui.lev;
    if (ty === 'stop_market') ui.otype = 'stop_limit';
    const isStop = ty === 'stop_limit' || ty === 'tp_limit', isLimit = ty !== 'market', ddLbl = (OTYPES.find(x => x[0] === ty) || OTYPES[0])[1];
    const levs = levSteps(p), draft = L.draft || lev, li = levs.reduce((b, x, i) => (x <= draft ? i : b), 0), opt = p.kind !== 'perp', longLbl = !opt || isMob();
    const stp = (k) => `<span class="stp"><i data-st="${k}" data-d="1">▴</i><i data-st="${k}" data-d="-1">▾</i></span>`;
    $('#orderPanel').innerHTML = `<div class="dop">
      <div class="dside"><a data-sd="buy" class="b ${sd === 'buy' ? 'on' : ''}">${longLbl ? 'Buy | Long' : 'Buy'}</a><a data-sd="sell" class="s ${sd === 'sell' ? 'on' : ''}">${longLbl ? 'Sell | Short' : 'Sell'}</a></div>
      <div class="dlev ${L.open ? 'open' : ''}"><div class="dlev-h" data-lv="toggle"><span>Leverage</span>${L.open ? '<b class="car">⌃</b>' : `<b class="acc">${lev}x <span class="car">▾</span></b>`}</div>
        ${L.open ? `<div class="dinp acc"><input id="lvN" inputmode="numeric" value="${draft}x"></div>
        <div class="dsl"><input type="range" id="lvR" min="0" max="${levs.length - 1}" step="1" value="${li}"><div class="dsl-l">${levs.map(x => `<span>${x}x</span>`).join('')}</div></div>
        ${opt ? `<label class="dchk"><input type="checkbox" id="lvDef" ${L.def ? 'checked' : ''}>Set ${draft}x as default for ${esc(p.under)} options</label>` : ''}
        <div class="dkv"><span class="dl">Max position at ${draft}x</span><b>${fmt(maxPosAt(p, draft), 1)} USD</b></div>
        <button class="dbtn" id="lvOk">Set to ${draft}x</button>` : ''}</div>
      <div class="dty"><a data-ty="limit" class="${ty === 'limit' ? 'on' : ''}">Limit</a><a data-ty="market" class="${ty === 'market' ? 'on' : ''}">Market</a>
        <a data-dd class="${isStop ? 'on' : ''}">${ddLbl} <span class="car">${ui.ddOpen ? '▴' : '▾'}</span></a>
        ${ui.ddOpen ? `<div class="ddm">${OTYPES.map(([k, l]) => `<a data-ty="${k}" class="${k === ty ? 'on' : ''}">${l}</a>`).join('')}</div>` : ''}</div>
      ${isStop ? `<div class="dinp"><select id="fTrig"><option value="mark"${f.trigger === 'mark' ? ' selected' : ''}>Mark</option><option value="last"${f.trigger === 'last' ? ' selected' : ''}>Last</option></select>
        <input id="fStop" inputmode="decimal" placeholder="Trigger Price USD" value="${f.stop}">${stp('stop')}</div>` : ''}
      ${isLimit ? `<div class="dinp"><input id="fPrice" inputmode="decimal" placeholder="Limit Price USD" value="${f.price}"><button class="best" id="pBest">${sd === 'buy' ? 'Best Offer' : 'Best Bid'}</button>${stp('price')}</div>` : ''}
      <div class="dinp"><input id="fQty" inputmode="decimal" placeholder="Enter Quantity" value="${f.qty}"><select id="fUnit"><option value="lot"${f.unit === 'lot' ? ' selected' : ''}>Lot</option><option value="base"${f.unit === 'base' ? ' selected' : ''}>${esc(p.unit || p.base)}</option></select></div>
      ${isStop ? '' : `<div class="dpct">${[10, 25, 50, 75, 100].map(x => `<a data-pc="${x}">${x}%</a>`).join('')}</div>`}
      <div class="dkv mut sm"><span id="qtyBase">~0.000 ${esc(p.unit || p.base)}</span><span>1 Lot = ${p.cv} ${esc(p.unit || p.base)}</span></div>
      ${isStop ? '' : `<div class="dkv"><span class="dl">Bracket Order</span><button class="dadd" id="tpAdd">${f.tpOn ? '− Remove TP/SL' : '+ Add TP/SL'}</button></div>
        ${f.tpOn ? `<div class="dinp"><input id="fTp" inputmode="decimal" placeholder="${p.kind === 'perp' ? 'Take Profit Trigger Price USD' : `TP · ${esc(p.under)} index price USD`}" value="${f.tp}"></div><div class="dinp"><input id="fSl" inputmode="decimal" placeholder="${p.kind === 'perp' ? 'Stop Loss Trigger Price USD' : `SL · ${esc(p.under)} index price USD`}" value="${f.sl}"></div>` : ''}
        <div class="dkv"><span class="dl">Funds req. <span class="rf">⟳</span></span><b id="kCost">~0.00 USD</b></div>`}
      <div class="dkv"><span>Available Margin</span><b id="kAvail">--</b></div>
      <button class="dsubmit ${sd === 'buy' ? 'b' : 's'}" data-side="${sd}">${sd === 'buy' ? 'Buy' : 'Sell'}</button>
      <div class="dkv"><label class="dchk"><input type="checkbox" id="fRed" ${f.reduce ? 'checked' : ''}><span class="dl">Reduce Only</span></label>
        ${ty === 'limit' ? `<select id="fTif" class="tif"><option value="gtc"${f.tif === 'gtc' ? ' selected' : ''}>GTC</option><option value="ioc"${f.tif === 'ioc' ? ' selected' : ''}>IOC</option></select>` : ''}</div>
      <div class="dfee"><a data-fee>% Fees</a>${ui.feesOpen ? `<div class="mut sm">Taker ${(p.taker * 100).toFixed(2)}% / Maker ${(p.maker * 100).toFixed(2)}% of notional${opt ? ' (spot × quantity), capped at 12.5% of premium' : ''}, + 18% GST. Est. <b id="kFee">--</b></div>` : ''}</div>
    </div>`;
    bindOptOrder();
    dirty();
  }
  function setQtyFromLots(n) {
    const p = P(); ui.f.size = String(Math.max(0, Math.floor(n)));
    ui.f.qty = !+ui.f.size ? '' : ui.f.unit === 'lot' ? ui.f.size : (+ui.f.size * p.cv).toFixed(decOf(p.cv));
    if ($('#fQty')) $('#fQty').value = ui.f.qty;
  }
  function bindOptOrder() {
    const op = $('#orderPanel'), p = P(), a = Engine.active, f = ui.f;
    op.onclick = async (e) => {
      const t = e.target;
      const sd = t.closest('[data-sd]'); if (sd) { if (sd.dataset.sd !== ui.side) { ui.side = sd.dataset.sd; renderOptOrder(); } return; }
      if (t.closest('[data-lv="toggle"]')) { ui.lev.open = !ui.lev.open; ui.lev.draft = Engine.levOf(a, ui.sym); return renderOptOrder(); }
      if (t.closest('[data-dd]')) { ui.ddOpen = !ui.ddOpen; return renderOptOrder(); }
      const ty = t.closest('[data-ty]'); if (ty) { ui.otype = ty.dataset.ty; ui.ddOpen = false; return renderOptOrder(); }
      const pc = t.closest('[data-pc]'); if (pc) { setQtyFromLots(maxSize(ui.side) * pc.dataset.pc / 100); return dirty(); }
      const st = t.closest('[data-st]'); if (st) { const k = st.dataset.st, cur = +ui.f[k] || T().mark || 0; setField(k, Math.max(p.tick, cur + st.dataset.d * p.tick).toFixed(p.dp)); return; }
      if (t.closest('#pBest')) { const v = ui.side === 'buy' ? T().ask : T().bid; if (v) setField('price', v.toFixed(p.dp)); return; }
      if (t.closest('#tpAdd')) { f.tpOn = !f.tpOn; return renderOptOrder(); }
      if (t.closest('[data-fee]')) { ui.feesOpen = !ui.feesOpen; return renderOptOrder(); }
      if (t.closest('#lvOk')) {
        const r = await Engine.setLeverage(a, ui.sym, ui.lev.draft, ui.lev.def); if (!r.ok) return toast('error', r.error);
        toast('success', `Leverage set to ${ui.lev.draft}x${ui.lev.def && p.kind !== 'perp' ? ` (default for ${p.under} options)` : ''}`); ui.lev.open = false; return renderOptOrder();
      }
      const sb = t.closest('.dsubmit'); if (sb) submit(sb.dataset.side);
    };
    const levs = levSteps(p), redrawLev = () => { const keep = document.activeElement && document.activeElement.id; renderOptOrder(); if (keep === 'lvN') { const n = $('#lvN'); n.focus(); n.setSelectionRange(n.value.length - 1, n.value.length - 1); } };
    $('#lvR') && ($('#lvR').oninput = (e) => { ui.lev.draft = levs[+e.target.value]; redrawLev(); });
    $('#lvN') && ($('#lvN').oninput = (e) => { const v = parseInt(e.target.value, 10); if (v >= 1) { ui.lev.draft = Math.min(p.maxLev, v); redrawLev(); } });
    $('#lvDef') && ($('#lvDef').onchange = (e) => { ui.lev.def = e.target.checked; });
    const bind = (id, key) => { const el = $(id); if (el) el.oninput = () => { f[key] = el.value; dirty(); }; };
    bind('#fStop', 'stop'); bind('#fPrice', 'price'); bind('#fTp', 'tp'); bind('#fSl', 'sl');
    $('#fQty').oninput = (e) => { f.qty = e.target.value.replace(/[^\d.]/g, ''); e.target.value = f.qty; f.size = String(f.unit === 'lot' ? Math.floor(+f.qty || 0) : Math.round((+f.qty || 0) / p.cv)); dirty(); };
    $('#fUnit').onchange = (e) => { f.unit = e.target.value; setQtyFromLots(+f.size || 0); dirty(); };
    $('#fTrig') && ($('#fTrig').onchange = (e) => f.trigger = e.target.value);
    $('#fTif') && ($('#fTif').onchange = (e) => f.tif = e.target.value);
    $('#fRed').onchange = (e) => f.reduce = e.target.checked;
  }
  function updateOptDyn() {
    if (!$('#kAvail')) return;
    const p = P(), a = Engine.active, sz = +ui.f.size || 0, s = Engine.summary(a);
    $('#qtyBase').textContent = `~${(sz * p.cv).toFixed(decOf(p.cv))} ${p.unit || p.base}`;
    $('#kAvail').textContent = `${fmt(s.available)} USD`;
    const px = refPrice(ui.side), probe = { symbol: ui.sym, side: ui.side, size: sz, filled: 0, price: ui.otype === 'market' ? 0 : px, reduceOnly: ui.f.reduce, status: 'open' };
    $('#kCost') && ($('#kCost').textContent = `~${fmt(sz ? Engine.orderMargin(a, probe) : 0)} USD`);
    $('#kFee') && ($('#kFee').textContent = `${fmt(sz * Engine.feeUnit(ui.sym, px, 'taker'), 4)} USD`);
  }

  async function submit(side) {
    const a = Engine.active, f = ui.f, p = P();
    const o = { symbol: ui.sym, side, type: ui.otype, size: f.size, price: f.price, stop: f.stop, trigger: f.trigger, reduceOnly: f.reduce, postOnly: f.post && ui.otype === 'limit' };
    {
      o.postOnly = false; o.tif = ui.otype === 'limit' ? f.tif : 'gtc';
      if (o.type !== 'market' && !(+o.price > 0)) o.price = side === 'buy' ? T().ask : T().bid; // empty limit price = Best Offer / Best Bid
      if (o.type === 'tp_limit' || o.type === 'stop_limit') {
        const cur = f.trigger === 'last' ? T().last : T().mark, st = +f.stop, tp = o.type === 'tp_limit';
        // Delta: a stop-loss triggers on an adverse move, a take-profit on a favourable one for the position this order closes
        if (st && cur && tp && (side === 'sell' ? st <= cur : st >= cur)) return toast('error', `Take profit trigger must be ${side === 'sell' ? 'above' : 'below'} the ${f.trigger} price`, 'Order Rejected');
        if (st && cur && !tp && (side === 'sell' ? st >= cur : st <= cur)) return toast('error', `Stop loss trigger must be ${side === 'sell' ? 'below' : 'above'} the ${f.trigger} price`, 'Order Rejected');
        o.type = 'stop_limit';
      }
    }
    if (f.tpOn && (p.kind === 'perp' || ui.otype !== 'stop_limit' && ui.otype !== 'tp_limit')) {
      const opt = p.kind !== 'perp', ref = opt ? Engine.spotOf(ui.sym) : refPrice(side), up = Engine.gainsUp(side === 'buy' ? 1 : -1, ui.sym), tp = +f.tp || null, sl = +f.sl || null, what = opt ? 'index price' : 'entry price';
      if (tp && (up ? tp <= ref : tp >= ref)) return toast('error', `Take profit must be ${up ? 'above' : 'below'} the ${what}`, 'Order Rejected');
      if (sl && (up ? sl >= ref : sl <= ref)) return toast('error', `Stop loss must be ${up ? 'below' : 'above'} the ${what}`, 'Order Rejected');
      o.tp = tp; o.sl = sl;
    }
    const r = await Engine.place(a, o);
    if (!r.ok) return toast('error', r.error, 'Order Rejected');
    if (r.order.status !== 'filled' && r.order.filled === 0) toast('success', `Your ${side} ${typeLbl(r.order.type)} order of ${r.order.size} lots in ${ui.sym}${r.order.price ? ' at ' + r.order.price.toFixed(p.dp) : ''} has been placed.`, 'Order Placed');
  }

  /* ================= bottom tables ================= */
  const botTabs = [['positions', 'Positions'], ['orders', 'Open Orders'], ['stops', 'Stop Orders'], ['account', 'Risk & Margin Details'], ['fills', 'Fills'], ['history', 'Order History']];
  function renderBotTabs() {
    const a = Engine.active;
    const cnt = { positions: Object.keys(a.positions).length, orders: a.orders.filter(o => o.status === 'open').length, stops: stopRows().length };
    if (!$('#btL')) $('#botTabs').innerHTML = '<span id="btL" class="btl"></span><span class="grow"></span><span id="btR" class="btr"></span>';
    const sm = Engine.summary(a), mmr = sm.equity > 0 ? Engine.maintenance(a) / sm.equity : 1;
    const health = mmr < 0.5 ? ['ok', 'Healthy'] : mmr < 1 ? ['warn', 'At Risk'] : ['bad', 'Liquidation'];
    const html = botTabs.map(([k, l]) => `<a data-k="${k}" class="${k === ui.botTab ? 'on' : ''}">${l}${cnt[k] ? ` (${cnt[k]})` : ''}${k === 'account' ? ` <i class="hbadge ${health[0]}">${health[1]}</i>` : ''}</a>`).join('');
    if ($('#btL').dataset.h !== html) { $('#btL').dataset.h = html; $('#btL').innerHTML = html; }
    if ($('#btR').dataset.k !== ui.botTab) {
      $('#btR').dataset.k = ui.botTab;
      const cols = `<a class="bt-link" data-k="cols" title="Choose columns">${IC_COLS}Columns</a>`;
      $('#btR').innerHTML = ui.botTab === 'positions' ? `<div class="dinp bt-q"><input id="posQ" placeholder="Search" autocomplete="off"></div>${cols}<button class="bt-pay" data-k="payoff">${IC_PAY}Payoff</button><button class="bt-close" data-k="closeall">Close All Positions</button>`
        : ui.botTab === 'orders' || ui.botTab === 'stops' ? `<div class="dinp bt-q"><input id="posQ" placeholder="Search" autocomplete="off"></div>${cols}<button class="bt-close" data-k="cancelall">Cancel All Orders</button>`
        : ui.botTab === 'fills' || ui.botTab === 'history' ? `${cols}<a class="bt-link" data-k="refresh">${IC_REF}Refresh</a><a class="bt-link acc" data-k="csv">${IC_DL}Download</a>` : '';
      const q = $('#posQ'); if (q) { q.value = ui.posQ; q.oninput = () => { ui.posQ = q.value; dirty(true); }; }
    }
  }
  const IC_REF = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>';
  const IC_DL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/></svg>';
  const IC_COLS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11M10 2.5v11"/></svg>';
  /* column name from a heading's HTML; '' for the checkbox / unnamed columns, which can't be hidden */
  const colName = (h) => { const t = String(h).replace(/<[^>]*>/g, '').trim(); return t === 'Symbol' || t === 'Action' ? '' : t; };
  function ccyMenu(btn) {
    const old = $('#ccyMenu'); if (old) return old.remove();
    const m = document.createElement('div'); m.id = 'ccyMenu'; m.className = 'colmenu ccymenu';
    m.innerHTML = [['USD', 'USD ($)'], ['INR', 'INR (₹)']].map(([c, l]) => `<a data-ccy="${c}" class="${ui.ccy === c ? 'on' : ''}">${l}</a>`).join('');
    document.body.appendChild(m);
    const r = btn.getBoundingClientRect(); m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = (r.bottom + 6 + m.offsetHeight < innerHeight ? r.bottom + 6 : r.top - 6 - m.offsetHeight) + 'px';
    m.onclick = (e) => { const c = e.target.closest('[data-ccy]'); if (!c) return; ui.ccy = c.dataset.ccy; saveUi(); m.remove(); dirty(true); };
    setTimeout(() => document.addEventListener('mousedown', function shut(e) { if (!m.contains(e.target) && !e.target.closest('[data-act="ccy"]')) { m.remove(); document.removeEventListener('mousedown', shut); } }), 0);
  }
  function colsMenu(btn) {
    const old = $('#colMenu'); if (old) { old.remove(); if (old.dataset.k === ui.botTab) return; }
    const k = ui.botTab, labels = (ui.colLabels[k] || []).filter(Boolean); if (!labels.length) return;
    const m = document.createElement('div'); m.id = 'colMenu'; m.className = 'colmenu'; m.dataset.k = k;
    const draw = () => {
      const off = ui.cols[k] || [];
      m.innerHTML = `<div class="cm-h"><b>Columns</b><a data-cm="reset">Reset</a></div>` + labels.map(l => `<label><input type="checkbox" data-cm-col="${esc(l)}" ${off.includes(l) ? '' : 'checked'}><span>${esc(l)}</span></label>`).join('');
    };
    draw(); document.body.appendChild(m);
    // open on the side of the button with more room, never past the screen edge: a long list scrolls inside the menu
    const r = btn.getBoundingClientRect(), w = m.offsetWidth, above = r.top - 14, below = innerHeight - r.bottom - 14;
    const up = m.offsetHeight > below && above > below; m.style.maxHeight = Math.min(420, Math.max(120, up ? above : below)) + 'px';
    m.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    const top = up ? r.top - 6 - m.offsetHeight : r.bottom + 6;
    m.style.top = Math.max(8, Math.min(top, innerHeight - m.offsetHeight - 8)) + 'px';
    m.onclick = (e) => { if (e.target.closest('[data-cm="reset"]')) { delete ui.cols[k]; saveUi(); draw(); dirty(true); } };
    m.onchange = (e) => {
      const l = e.target.dataset.cmCol; if (l == null) return;
      const off = new Set(ui.cols[k] || []); e.target.checked ? off.delete(l) : off.add(l);
      if (off.size) ui.cols[k] = [...off]; else delete ui.cols[k]; saveUi(); dirty(true);
    };
    setTimeout(() => document.addEventListener('mousedown', function shut(e) { if (!m.contains(e.target) && !e.target.closest('[data-k="cols"]')) { m.remove(); document.removeEventListener('mousedown', shut); } }), 0);
  }
  const IC_PAY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1.5 12.5h13M2.5 11l4-4 2.5 2 5-5.5"/></svg>';
  $('#botTabs').onclick = (e) => {
    const k = e.target.closest('[data-k]') && e.target.closest('[data-k]').dataset.k; if (!k) return;
    if (k === 'closeall') return closeAllDialog();
    if (k === 'cancelall') return cancelAllDialog();
    if (k === 'payoff') return payoffDialog();
    if (k === 'csv') return downloadCsv(e.target.closest('[data-k]'));
    if (k === 'cols') return colsMenu(e.target.closest('[data-k]'));
    if (k === 'refresh') { const b = e.target.closest('[data-k]'); b.classList.add('spin'); Engine.refresh().then(() => { setTimeout(() => b.classList.remove('spin'), 400); dirty(true); }); return; }
    ui.botTab = k; const cm = $('#colMenu'); if (cm) cm.remove(); dirty(true);
  };
  /* the All / Current Contract / Options / Futures chips (and search) used by every table */
  const symShown = (sym, search) => {
    const p = Feed.products[sym]; if (!p) return false;
    if (ui.posFilter === 'current' && sym !== ui.sym) return false;
    if (ui.posFilter === 'options' && p.kind === 'perp') return false;
    if (ui.posFilter === 'futures' && p.kind !== 'perp') return false;
    return !search || !ui.posQ.trim() || sym.toLowerCase().includes(ui.posQ.trim().toLowerCase());
  };
  const byTime = (a, b) => (ui.ordAsc ? 1 : -1) * (a.ts - b.ts);
  const lotsSigned = (side, n) => `<span class="${side === 'buy' ? 'buy' : 'sell'}">${side === 'buy' ? '' : '-'}${fmt(n, 0)}</span>`;
  const baseQty = (p, n) => `${(n * p.cv).toFixed(decOf(p.cv))} ${esc(p.unit || p.base)}`;
  const notionalOf = (sym, lots, px) => { const p = Feed.products[sym]; return lots * p.cv * (p.kind === 'perp' ? (px || (Feed.tickers[sym] || {}).mark || 0) : Engine.spotOf(sym)); };
  /* Stop Orders: real stop orders plus each position's TP / SL, which Delta lists as "Bracket - TP / SL" */
  function stopRows() {
    const a = Engine.active, rows = a.orders.filter(o => o.status === 'untriggered').map(o => ({ key: 'o' + o.id, o, sym: o.symbol, side: o.side, lots: o.size - o.filled, ts: o.ts }));
    for (const [sym, pos] of Object.entries(a.positions)) for (const leg of ['tp', 'sl']) if (pos[leg]) {
      const up = Engine.gainsUp(pos.size, sym, pos.tpslTrig), above = leg === 'tp' ? up : !up;
      rows.push({ key: `b${leg}:${sym}`, leg, sym, pos, side: pos.size > 0 ? 'sell' : 'buy', lots: Math.abs(pos.size), trig: pos[leg], above, ts: pos.tpslTs || pos.opened || 0 });
    }
    return rows;
  }
  const histTime = (ts) => { const d = new Date(ts), h = d.getHours(); return `${z2(d.getDate())} - ${MON[d.getMonth()]} - ${String(d.getFullYear()).slice(2)}, ${h % 12 || 12}:${z2(d.getMinutes())}:${z2(d.getSeconds())} ${h < 12 ? 'Am' : 'Pm'}`; };
  const clock = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const dayCell = (ts, yr) => { const d = new Date(ts); return `<b class="tday">${yr ? d.getDate() : z2(d.getDate())} ${MON[d.getMonth()]}${yr ? ' ' + String(d.getFullYear()).slice(2) : ''}</b><small class="mut tclk">${clock(ts)}</small>`; };
  const typeLbl = (t) => ({ limit: 'Limit', market: 'Market', stop_limit: 'Stop Limit', stop_market: 'Stop Market' })[t] || t;
  const orderById = (id) => { const a = Engine.active; return a.orders.find(o => o.id === id) || a.history.find(o => o.id === id); };
  /* per order: net PnL and fees (recorded on new orders; older ones are summed from their fills) */
  function orderPnl(o) {
    if (o.pnl !== undefined) return { pnl: o.pnl, fee: o.fee || 0 };
    let pnl = 0, fee = 0; for (const f of Engine.active.fills) if (f.orderId === o.id) { pnl += f.realized || 0; fee += f.fee || 0; }
    return { pnl, fee };
  }
  /* rows of each order table as plain values: drawn as HTML and exported as CSV */
  function tableData(k, src) {
    const a = src || Engine.active, byId = src ? new Map(src.history.map(o => [o.id, o])) : null;
    if (k === 'fills') return a.fills.filter(f => symShown(f.symbol)).map(f => {
      const p = Feed.products[f.symbol] || { cv: 1, kind: 'perp', dp: 2, unit: '' }, o = (byId ? byId.get(f.orderId) || orderById(f.orderId) : orderById(f.orderId)) || {};
      const nt = f.size * p.cv * (p.kind === 'perp' ? f.price : (o.idx || Engine.spotOf(f.symbol) || f.price));
      return { f, p, nt, otype: o.type || (f.role === 'liquidation' ? 'market' : 'limit'), oqty: o.size || f.size,
        ftype: f.role === 'settlement' ? 'Settlement' : f.role === 'liquidation' ? 'Liquidation' : 'Normal', role: f.role === 'maker' ? 'Maker' : 'Taker' };
    });
    if (k === 'history') return a.history.filter(o => symShown(o.symbol)).map(o => {
      const p = Feed.products[o.symbol] || { cv: 1, kind: 'perp', dp: 2, unit: '' }, { pnl, fee } = orderPnl(o);
      const closing = o.closing !== undefined ? o.closing : (o.reduceOnly || Math.abs(pnl + fee) > 1e-9);
      const cash = p.kind === 'perp' || o.reason === 'settlement' ? 0 : (o.side === 'buy' ? -1 : 1) * o.filled * p.cv * (o.avg || 0);
      const st = { filled: 'Filled', cancelled: 'Cancelled', partially_filled_cancelled: 'Partially Filled' }[o.status] || o.status;
      return { o, p, pnl, fee, closing, cash, st: o.reason === 'expired' ? 'Expired' : st };
    });
    return [];
  }
  async function downloadCsv(btn) {
    if (btn && btn.classList.contains('busy')) return;
    if (btn) btn.classList.add('busy');
    const src = await Engine.exportData(Engine.active); if (btn) btn.classList.remove('busy');
    if (!src || !src.ok) return toast('error', (src && src.error) || 'Could not load your history', 'Download Failed');
    const k = ui.botTab, q = (v) => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    let head, rows;
    if (k === 'fills') {
      head = ['Symbol', 'Fill Qty (Lot)', 'Side', 'Order Qty (Lot)', 'Execution Price', 'Notional (USD)', 'Size', 'Fill Type', 'Order Type', 'Role', 'Fee (USD)', 'Realized PnL (USD)', 'Order ID', 'Fill ID', 'Time'];
      rows = tableData('fills', src).map(({ f, p, nt, otype, oqty, ftype, role }) => [f.symbol, (f.side === 'buy' ? '' : '-') + f.size, f.side === 'buy' ? 'Buy' : 'Sell', oqty, f.price, nt.toFixed(4), (f.side === 'buy' ? '' : '-') + (f.size * p.cv).toFixed(decOf(p.cv)) + ' ' + (p.unit || p.base || ''), ftype, typeLbl(otype), role, (f.fee || 0).toFixed(4), (f.realized || 0).toFixed(4), f.orderId || '', f.id, new Date(f.ts).toISOString()]);
    } else {
      head = ['Symbol', 'Qty (Lot)', 'Side', 'Status', 'Filled (Lot)', 'Order Type', 'Limit Price', 'Trigger Price', 'Execution Price', 'Size', 'Cashflow (USD)', 'Realized PnL (USD)', 'Trading Fees Inc. GST (USD)', 'Net PnL (USD)', 'Order ID', 'Reduce-Only', 'Time'];
      rows = tableData('history', src).map(({ o, p, pnl, fee, closing, cash, st }) => [o.symbol, (o.side === 'buy' ? '' : '-') + o.size, (closing ? 'Close ' : 'Open ') + (o.side === 'buy' ? 'Buy' : 'Sell'), st, o.filled, typeLbl(o.type), o.price || '', o.stop || '', o.avg || '', (o.side === 'buy' ? '' : '-') + (o.size * p.cv).toFixed(decOf(p.cv)) + ' ' + (p.unit || p.base || ''), cash.toFixed(2), (pnl + fee).toFixed(4), fee.toFixed(4), pnl.toFixed(4), o.id, o.reduceOnly ? 'Yes' : 'No', new Date(o.ts).toISOString()]);
    }
    const csv = [head, ...rows].map(r => r.map(q).join(',')).join('\n'), d = new Date();
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), el = document.createElement('a');
    el.href = url; el.download = `delta-demo-${k === 'fills' ? 'fills' : 'order-history'}-${d.getFullYear()}${z2(d.getMonth() + 1)}${z2(d.getDate())}.csv`; el.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); toast('success', `${rows.length} rows saved as CSV.`, 'Download Complete');
  }
  function cancelAllDialog() {
    const a = Engine.active, k = ui.botTab;
    const ords = k === 'stops' ? stopRows().filter(r => symShown(r.sym, true) && !ui.ordOff.has(r.key)) : a.orders.filter(o => o.status === 'open' && symShown(o.symbol, true) && !ui.ordOff.has('o' + o.id)).map(o => ({ key: 'o' + o.id, o, sym: o.symbol }));
    if (!ords.length) return toast('info', 'No orders selected');
    ask(`Cancel ${ords.length} order${ords.length > 1 ? 's' : ''}?`, [], async () => { for (const r of ords) await cancelRow(r); }, { ok: 'Cancel Orders', danger: true, note: ords.map(r => r.sym).join(', ') });
  }
  async function cancelOrder(o) {
    const r = await Engine.cancel(Engine.active, o.id);
    if (r && r.ok === false) return toast('error', r.error);
    toast('error', `Your ${o.side} ${typeLbl(o.type)} order in ${o.symbol} has been cancelled.`, 'Order Cancelled');
  }
  async function cancelRow(r) {
    const a = Engine.active;
    if (r.o) return cancelOrder(r.o);
    const pos = a.positions[r.sym]; if (!pos) return;
    const res = await Engine.setTpSl(a, r.sym, r.leg === 'tp' ? null : pos.tp, r.leg === 'sl' ? null : pos.sl, { trig: pos.tpslTrig, tpLim: pos.tpLim, slLim: pos.slLim });
    if (!res.ok) return toast('error', res.error);
    toast('error', `Your ${r.side} Bracket - ${r.leg.toUpperCase()} order in ${r.sym} has been cancelled.`, 'Order Cancelled');
  }
  /* positions the toolbar filters / search / checkboxes leave in view, sorted by time placed */
  function shownPositions() {
    const a = Engine.active, q = ui.posQ.trim().toLowerCase();
    return Object.entries(a.positions).filter(([sym]) => {
      const p = Feed.products[sym]; if (!p) return false;
      if (ui.posFilter === 'current' && sym !== ui.sym) return false;
      if (ui.posFilter === 'options' && p.kind === 'perp') return false;
      if (ui.posFilter === 'futures' && p.kind !== 'perp') return false;
      return !q || sym.toLowerCase().includes(q);
    }).sort((x, y) => (ui.posAsc ? 1 : -1) * ((x[1].opened || 0) - (y[1].opened || 0)));
  }
  function closeAllDialog() {
    const list = shownPositions().filter(([sym]) => !ui.posOff.has(sym));
    if (!list.length) return toast('info', 'No positions selected');
    ask(`Close ${list.length} position${list.length > 1 ? 's' : ''}?`, [], async () => {
      for (const [sym] of list) { const r = await Engine.closePosition(Engine.active, sym, 'market'); if (!r.ok) toast('error', `${sym}: ${r.error}`); }
    }, { ok: 'Close at Market', danger: true, note: list.map(([sym]) => sym).join(', ') });
  }
  /* Close Position: market or limit, all or part of the position (a reduce-only order), styled like the bracket dialog */
  function closeDialog(sym) {
    const a = Engine.active, pos = a.positions[sym], p = Feed.products[sym]; if (!pos) return;
    const long = pos.size > 0, lots = Math.abs(pos.size), cd = decOf(p.cv), st = { limit: false };
    const t0 = Feed.tickers[sym] || {}, px0 = long ? t0.bid : t0.ask;
    modal(`<div class="bk cl"><h3>Close Position: ${esc(sym)} <button class="x" data-close>×</button></h3>
      <div class="bk-row"><span>Position</span><b class="${long ? 'buy' : 'sell'}">${long ? 'Long' : 'Short'} ${fmt(lots, 0)} Lot${lots === 1 ? '' : 's'} · ${(lots * p.cv).toFixed(cd)} ${esc(p.unit || p.base)}</b></div>
      <div class="bk-row"><span>Entry Price</span><b>${pos.entry.toFixed(p.dp)}</b></div>
      <div class="bk-row"><span>Mark Price</span><b id="clMark">-</b></div>
      <div class="bk-sec">
        <div class="cl-seg"><button data-cl="market" class="on">Market</button><button data-cl="limit">Limit</button></div>
        <div class="bk-lim" id="clLimRow" style="display:none"><label>Limit Price</label><div class="bk-inp"><input id="clPx" inputmode="decimal" placeholder="Limit Price USD" value="${px0 ? px0.toFixed(p.dp) : ''}"></div></div>
        <label style="margin-top:6px">Quantity</label><div class="bk-inp"><input id="clQty" inputmode="numeric" value="${lots}"><span class="cl-u">Lots</span></div>
        <div class="bk-pct cl-pct">${[25, 50, 75, 100].map(x => `<a data-clp="${x}" class="${x === 100 ? 'on' : ''}">${x}%</a>`).join('')}</div>
      </div>
      <div class="bk-foot"><div class="bk-pnl"><div><span>Est. Realized PnL</span><b id="clPnl">-</b></div></div>
        <button class="bk-ok cl-ok ${long ? 'sell' : 'buy'}" id="clOk"></button></div></div>`);
    const box = $('#mbox'); box.classList.add('bkbox');
    const qty = () => Math.floor(+$('#clQty').value || 0);
    const draw = () => {
      const t = Feed.tickers[sym] || {}, q = qty(), ex = st.limit ? +$('#clPx').value : (long ? t.bid : t.ask) || t.mark;
      $('#clMark').textContent = t.mark ? t.mark.toFixed(p.dp) : '-';
      box.querySelectorAll('[data-cl]').forEach(b => b.classList.toggle('on', (b.dataset.cl === 'limit') === st.limit));
      $('#clLimRow').style.display = st.limit ? '' : 'none';
      box.querySelectorAll('[data-clp]').forEach(b => b.classList.toggle('on', Math.floor(lots * b.dataset.clp / 100) === q && q > 0));
      const pnl = q > 0 && ex ? (ex - pos.entry) * (long ? 1 : -1) * q * p.cv : null, el = $('#clPnl');
      el.textContent = pnl == null ? '-' : `${st.limit ? '' : '≈ '}${sgn(pnl)} USD`; el.className = pnl == null ? '' : cls(pnl);
      $('#clOk').textContent = `${q >= lots ? 'Close' : 'Reduce'} ${long ? 'Long' : 'Short'}${q > 0 ? ` · ${fmt(Math.min(q, lots), 0)} Lot${q === 1 ? '' : 's'}` : ''}`;
    };
    const root = box.querySelector('.cl'); // the mark / PnL refresh belongs to this dialog only; it stops when the dialog is gone
    draw(); const live = setInterval(() => { if (!document.contains(root)) return clearInterval(live); draw(); }, 1000);
    box.oninput = draw;
    box.onclick = async (e) => {
      if (e.target.closest('[data-close]')) return closeModal();
      const ty = e.target.closest('[data-cl]'); if (ty) { st.limit = ty.dataset.cl === 'limit'; return draw(); }
      const pc = e.target.closest('[data-clp]'); if (pc) { $('#clQty').value = Math.max(1, Math.floor(lots * pc.dataset.clp / 100)); return draw(); }
      if (e.target.closest('#clOk')) {
        const q = qty(), lim = +$('#clPx').value;
        if (!(q > 0)) return toast('error', 'Enter a quantity of at least 1 lot', 'Order Rejected');
        if (q > lots) return toast('error', `You can close at most ${fmt(lots, 0)} lots`, 'Order Rejected');
        if (st.limit && !(lim > 0)) return toast('error', 'Enter a limit price', 'Order Rejected');
        closeModal();
        const r = q >= lots ? await Engine.closePosition(a, sym, st.limit ? 'limit' : 'market', st.limit ? lim : undefined)
          : await Engine.place(a, { symbol: sym, side: long ? 'sell' : 'buy', type: st.limit ? 'limit' : 'market', size: q, price: st.limit ? lim : undefined, reduceOnly: true });
        if (r && r.ok === false) toast('error', r.error, 'Order Rejected');
      }
    };
  }
  /* "Add / Edit Bracket Order" for a position (sym) or for an open order (id) */
  function bracketDialog({ sym, id }) {
    const a = Engine.active, o = id ? a.orders.find(x => x.id === id) : null, pos = sym ? a.positions[sym] : null; if (!o && !pos) return;
    const S = sym || o.symbol, p = Feed.products[S], src = pos || o, size = pos ? pos.size : (o.side === 'buy' ? 1 : -1) * (o.size - o.filled);
    const entry = pos ? pos.entry : (o.price || (Feed.tickers[S] || {}).mark || 0), edit = !!(src.tp || src.sl);
    const st = { trig: src.tpslTrig || (p.kind === 'perp' ? 'mark' : 'index'), tpLimit: !!src.tpLim, slLimit: !!src.slLim };
    const ref = () => Engine.tpslRef(S, st.trig), up = () => Engine.gainsUp(size, S, st.trig);
    const leg = (k, title) => `<div class="bk-sec"><div class="bk-h"><b class="dl">${title}</b><button class="bk-type" data-type="${k}"></button></div>
      <label class="dl">Trigger Price</label><div class="bk-inp"><input id="bk_${k}" inputmode="decimal" placeholder="Trigger Price USD" value="${src[k] || ''}"></div>
      <div class="bk-pct">${[5, 10, 15, 20].map(x => `<a data-pct="${x}" data-leg="${k}">${x}%</a>`).join('')}<span id="bkp_${k}">0%</span></div>
      <div class="bk-lim" id="bkl_${k}"><label class="dl">Limit Price</label><div class="bk-inp"><input id="bkL_${k}" inputmode="decimal" placeholder="Limit Price USD" value="${src[k + 'Lim'] || ''}"></div></div></div>`;
    modal(`<div class="bk"><h3>${edit ? 'Edit' : 'Add'} Bracket Order: ${esc(S)} <button class="x" data-close>×</button></h3>
      <div class="bk-row"><span>${pos ? 'Entry Price' : 'Order Price'}</span><b>${(+entry).toFixed(p.dp)}</b></div>
      <div class="bk-row"><span class="dl">Trigger Index</span><select id="bkTrig" class="bk-sel"></select></div>
      ${leg('tp', 'Take Profit')}<div class="bk-div"></div>${leg('sl', 'Stop Loss')}
      <div class="bk-foot ${edit ? 'edit' : ''}"><div class="bk-pnl"><div><span>Exit PnL</span><b id="bkPnl_tp">-</b></div><div><span>Stop PnL</span><b id="bkPnl_sl">-</b></div></div>
        <button class="bk-ok" id="bkOk">${edit ? 'Update' : 'Confirm'}</button></div></div>`);
    const box = $('#mbox'); box.classList.add('bkbox');
    const val = (k) => +$('#bk_' + k).value || 0;
    // estimated exit price at a trigger: mark trigger = that price; index trigger = mark moved by delta (options) or 1:1 (futures)
    const exitPx = (k) => {
      const lim = st[k + 'Limit'] && +$('#bkL_' + k).value; if (lim) return lim;
      const t = Feed.tickers[S] || {}, trig = val(k); if (!trig) return 0;
      if (st.trig === 'mark') return trig;
      const d = p.kind === 'perp' ? 1 : ((t.greeks && t.greeks.delta) || 0);
      return Math.max(0, (t.mark || 0) + d * (trig - Engine.spotOf(S)));
    };
    const draw = () => {
      const t = Feed.tickers[S] || {};
      $('#bkTrig').innerHTML = `<option value="index"${st.trig === 'index' ? ' selected' : ''}>Index ${num1(Engine.spotOf(S), 1)}</option><option value="mark"${st.trig === 'mark' ? ' selected' : ''}>Mark ${(t.mark || 0).toFixed(p.dp)}</option>`;
      for (const k of ['tp', 'sl']) {
        box.querySelector(`[data-type="${k}"]`).textContent = st[k + 'Limit'] ? 'Limit' : 'Market';
        $('#bkl_' + k).style.display = st[k + 'Limit'] ? '' : 'none';
        const v = val(k), r = ref(); $('#bkp_' + k).textContent = v && r ? (Math.abs(v - r) / r * 100).toFixed(2) + '%' : '0%';
        const ex = exitPx(k), pnl = ex ? (ex - entry) * size * p.cv : null, el = $('#bkPnl_' + k);
        el.textContent = pnl == null ? '-' : `${st.trig === 'index' && !st[k + 'Limit'] && p.kind !== 'perp' ? '≈ ' : ''}${sgn(pnl)} USD`; el.className = pnl == null ? '' : cls(pnl);
      }
    };
    draw();
    box.oninput = draw;
    box.onchange = (e) => { if (e.target.id === 'bkTrig') { st.trig = e.target.value; draw(); } };
    box.onclick = async (e) => {
      if (e.target.closest('[data-close]')) return closeModal();
      const ty = e.target.closest('[data-type]'); if (ty) { const k = ty.dataset.type + 'Limit'; st[k] = !st[k]; return draw(); }
      const pc = e.target.closest('[data-pct]'); if (pc) {
        const k = pc.dataset.leg, x = +pc.dataset.pct / 100, r = ref(), gain = up() ? 1 : -1, dir = k === 'tp' ? gain : -gain;
        const tick = st.trig === 'mark' ? p.tick : 0.1, v = Math.max(tick, Math.round(r * (1 + dir * x) / tick) * tick);
        $('#bk_' + k).value = +v.toFixed(st.trig === 'mark' ? p.dp : 1); return draw();
      }
      if (e.target.closest('#bkOk')) {
        const tp = val('tp') || null, sl = val('sl') || null;
        const opt = { trig: st.trig, tpLim: st.tpLimit ? (+$('#bkL_tp').value || null) : null, slLim: st.slLimit ? (+$('#bkL_sl').value || null) : null };
        if ((st.tpLimit && tp && !opt.tpLim) || (st.slLimit && sl && !opt.slLim)) return toast('error', 'Enter a limit price or switch that leg to Market', 'Bracket Order');
        const r = pos ? await Engine.setTpSl(a, S, tp, sl, opt) : await Engine.setOrderTpSl(a, o.id, tp, sl, opt);
        if (!r.ok) return toast('error', r.error, 'Bracket Order Rejected');
        closeModal(); toast('success', pos ? `Your bracket order for ${S} has been ${edit ? 'updated' : 'placed'}.` : `TP / SL will be attached to ${S} when this order fills.`, edit ? 'Bracket Order Updated' : 'Bracket Order Placed');
      }
    };
  }
  /* Payoff: P&L at expiry of the selected positions in one underlying, against that underlying's price */
  function payoffDialog() {
    const list = shownPositions().filter(([sym]) => !ui.posOff.has(sym));
    if (!list.length) return toast('info', 'No positions selected');
    const unders = [...new Set(list.map(([sym]) => Feed.products[sym].under))];
    const draw = (u) => {
      modal(`<h3>Payoff at expiry <button class="x" data-close>×</button></h3>${unders.length > 1 ? `<div class="seg" style="margin-bottom:10px">${unders.map(x => `<button data-pu="${x}" class="${x === u ? 'on' : ''}">${x}</button>`).join('')}</div>` : ''}
        <canvas id="payCv" width="600" height="300" style="width:100%;height:300px;display:block"></canvas><div class="mnote" id="payInfo" style="margin-top:8px"></div>`);
      $('#mbox').onclick = (e) => { if (e.target.closest('[data-close]')) closeModal(); const b = e.target.closest('[data-pu]'); if (b) draw(b.dataset.pu); };
      const legs = list.filter(([sym]) => Feed.products[sym].under === u).map(([sym, pos]) => ({ p: Feed.products[sym], q: pos.size * Feed.products[sym].cv, entry: pos.entry }));
      const spot = Feed.spotOf(u) || 1, ks = legs.filter(l => l.p.strike).map(l => l.p.strike);
      const lo = Math.min(spot * 0.9, ...ks.map(k => k * 0.97)), hi = Math.max(spot * 1.1, ...ks.map(k => k * 1.03));
      const pnl = (S) => legs.reduce((acc, l) => acc + l.q * ((l.p.kind === 'call' ? Math.max(S - l.p.strike, 0) : l.p.kind === 'put' ? Math.max(l.p.strike - S, 0) : S) - l.entry), 0);
      const N = 240, pts = Array.from({ length: N + 1 }, (_, i) => { const S = lo + (hi - lo) * i / N; return [S, pnl(S)]; });
      const ys = pts.map(x => x[1]), yMax = Math.max(...ys, 0), yMin = Math.min(...ys, 0), pad = (yMax - yMin) * 0.1 || 1;
      const cv = $('#payCv'), r = window.devicePixelRatio || 1, W = cv.clientWidth, H = 300; cv.width = W * r; cv.height = H * r;
      const g = cv.getContext('2d'); g.scale(r, r);
      const X = (S) => 50 + (S - lo) / (hi - lo) * (W - 60), Y = (v) => 10 + (yMax + pad - v) / (yMax - yMin + 2 * pad) * (H - 40);
      g.strokeStyle = '#2b2e35'; g.beginPath(); g.moveTo(50, Y(0)); g.lineTo(W - 10, Y(0)); g.stroke();
      for (const [S, v] of pts) { g.fillStyle = v >= 0 ? '#24b47e33' : '#ef5a5a33'; g.fillRect(X(S), Math.min(Y(v), Y(0)), (W - 60) / N + 1, Math.abs(Y(v) - Y(0))); }
      g.beginPath(); pts.forEach(([S, v], i) => i ? g.lineTo(X(S), Y(v)) : g.moveTo(X(S), Y(v))); g.strokeStyle = '#f7861c'; g.lineWidth = 2; g.stroke();
      g.setLineDash([4, 4]); g.strokeStyle = '#9aa0a8'; g.beginPath(); g.moveTo(X(spot), 10); g.lineTo(X(spot), H - 30); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#9aa0a8'; g.font = '11px Inter, Segoe UI, sans-serif';
      for (let i = 0; i <= 4; i++) { const S = lo + (hi - lo) * i / 4; g.fillText(Math.round(S), Math.min(X(S) - 14, W - 50), H - 12); }
      g.fillText(`${sgn(yMax, 0)}`, 4, Y(yMax) + 4); g.fillText(`${sgn(yMin, 0)}`, 4, Y(yMin) + 4); g.fillText('0', 4, Y(0) + 4);
      $('#payInfo').innerHTML = `${u} index ${num1(spot, 1)} · P&L at expiry if it stays here: <b class="${cls(pnl(spot))}">${sgn(pnl(spot))} USD</b> · in this range max <b class="buy">${sgn(yMax)}</b> / min <b class="sell">${sgn(yMin)}</b> USD · ${legs.length} leg${legs.length > 1 ? 's' : ''}`;
    };
    draw(unders.includes(P() && P().under) ? P().under : unders[0]);
  }
  const time = (ts) => new Date(ts).toLocaleString([], { hour12: false, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dp = (s) => Feed.products[s] ? Feed.products[s].dp : 2;
  const typeName = (o) => o.type.replace('_', ' ');

  function botHtml() {
    const a = Engine.active, k = ui.botTab;
    // column headings stay visible even when empty, so the panel below the fold reads as a table
    // Delta-style pages: "30 / Page" with ‹ 1 - 30 › under each table
    const tbl = (head, rows, msg) => {
      const n = rows.length, size = ui.pageSize, pages = Math.max(1, Math.ceil(n / size)), pg = Math.min(ui.pages[k] || 1, pages); ui.pages[k] = pg;
      const from = n ? (pg - 1) * size + 1 : 0, to = Math.min(n, pg * size);
      const pager = `<div class="pager"><select data-pgsz>${[10, 20, 30, 50, 100].map(x => `<option value="${x}"${x === size ? ' selected' : ''}>${x} / Page</option>`).join('')}</select>
        <button data-pg="-1" ${pg <= 1 ? 'disabled' : ''} title="Previous page">‹</button><span>${from} - ${to}</span><button data-pg="1" ${pg >= pages ? 'disabled' : ''} title="Next page">›</button></div>`;
      const labels = head.map(colName); ui.colLabels[k] = labels;
      const off = labels.map((l, i) => l && (ui.cols[k] || []).includes(l) ? `#botView tr>:nth-child(${i + 1})` : '').filter(Boolean);
      return (off.length ? `<style>${off.join(',')}{display:none}</style>` : '') + `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.slice(from ? from - 1 : 0, to).join('')}</tbody></table>` + (n ? '' : `<div class="empty">${msg}</div>`) + pager;
    };
    if (k === 'positions') {
      const list = shownPositions(), all = list.length && list.every(([sym]) => !ui.posOff.has(sym));
      const tot = list.reduce((acc, [sym, pos]) => acc + Engine.upnl(pos, sym), 0);
      const bar = `<div class="pbar"><div class="pchips">${[['all', 'All'], ['current', 'Current Contract'], ['options', 'Options'], ['futures', 'Futures']].map(([f, l]) => `<a data-pf="${f}" class="${f === ui.posFilter ? 'on' : ''}">${l}</a>`).join('')}</div>
        <span class="grow"></span><a class="pusd" data-act="ccy" title="Show values in USD or INR">${ui.ccy === 'INR' ? 'INR (₹)' : 'USD ($)'}<i class="pusd-c">▾</i></a><span class="ptot">Σ Total UPNL <b class="${cls(tot)}">${tot >= 0 ? '+' : '-'}${ccySym()}${ccyAmt(Math.abs(tot))}</b></span>
        <a class="psort" data-act="psort">Time Placed ${ui.posAsc ? '↑' : '↓'}</a></div>`;
      const head = [`<input type="checkbox" class="pck" data-act="pckall" ${all ? 'checked' : ''}>`, 'Symbol', 'Size', 'Notional', 'Entry Price', '<span class="dl">TP / SL</span>', 'Index Price', 'Mark Price', '<span class="dl">Est. Liq. Price</span>', '<span class="dl">Margin</span>', '<span class="dl">UPNL</span>', 'Share', 'Cashflows', 'Action'];
      return bar + tbl(head, list.map(([s, pos]) => {
        const p = Feed.products[s], o = p.kind !== 'perp', t = Feed.tickers[s] || {}, u = Engine.upnl(pos, s), d = p.dp, cd = decOf(p.cv), q = Math.abs(pos.size) * p.cv;
        const mk = t.mark || pos.entry, idx = Engine.spotOf(s), notional = q * (o ? idx : mk), pct = pos.entry ? u / (q * pos.entry) * 100 : 0, cash = -pos.size * p.cv * pos.entry, long = pos.size > 0;
        const tpsl = (l, v) => v ? `<span>${l} (USD): <b>${num1(v, 2)}</b></span>` : `<span>${l} : -</span>`;
        return `<tr><td><input type="checkbox" class="pck" data-act="pck" data-s="${s}" ${ui.posOff.has(s) ? '' : 'checked'}></td>
          <td class="psym ${long ? 'l' : 's'}"><a data-sym="${s}">${s}</a></td>
          <td class="${long ? 'buy' : 'sell'}">${long ? '+' : '-'}${q.toFixed(cd)} ${esc(p.unit || p.base)}</td>
          <td>${ccyAmt(notional)} <span class="mut">${ccyUnit()}</span></td><td>${pos.entry.toFixed(d)}</td>
          <td><div class="ptpsl"><div>${tpsl('TP', pos.tp)}${tpsl('SL', pos.sl)}</div><button class="ib" data-act="tpsl" data-s="${s}" title="Edit TP / SL">${IC.edit}</button><button class="ib" data-act="tpclr" data-s="${s}" title="Remove TP / SL" ${pos.tp || pos.sl ? '' : 'disabled'}>${IC.del}</button></div></td>
          <td>${num1(idx, 1)}</td><td>${mk.toFixed(d)}${o && t.iv ? `<small class="mut" style="display:block">${(t.iv * 100).toFixed(1)}%</small>` : ''}</td>
          <td><span class="dl">N.A.</span></td><td>${o && long ? '-' : `${ccyAmt(pos.margin)} <span class="mut">${ccyUnit()}</span>`}</td>
          <td class="${cls(u)}">${ccyAmt(u)} ${ccyUnit()}<small style="display:block">${pct.toFixed(2)}%</small></td>
          <td><button class="ib" data-act="share" data-s="${s}" title="Copy position">${IC_SHARE}</button></td>
          <td>${o ? `${ccyAmt(cash)} <span class="mut">${ccyUnit()}</span>` : '-'}</td>
          <td><button class="pclose" data-act="close" data-s="${s}" title="Close position">✕</button></td></tr>`;
      }), 'No open positions');
    }
    const chips = (right) => `<div class="pbar"><div class="pchips">${[['all', 'All'], ['current', 'Current Contract'], ['options', 'Options'], ['futures', 'Futures']].map(([f, l]) => `<a data-pf="${f}" class="${f === ui.posFilter ? 'on' : ''}">${l}</a>`).join('')}</div><span class="grow"></span>${right || ''}</div>`;
    const sorting = `<select class="psel" data-sort-ord><option value="desc"${ui.ordAsc ? '' : ' selected'}>Sorting: Newest first</option><option value="asc"${ui.ordAsc ? ' selected' : ''}>Sorting: Oldest first</option></select>`;
    const ck = (key) => `<input type="checkbox" class="pck" data-act="ock" data-key="${key}" ${ui.ordOff.has(key) ? '' : 'checked'}>`;
    const ckAll = (keys) => `<input type="checkbox" class="pck" data-act="ockall" data-keys="${keys.join(' ')}" ${keys.length && keys.every(x => !ui.ordOff.has(x)) ? 'checked' : ''}>`;
    const sym = (s, side) => `<td class="psym ${side === 'buy' ? 'l' : 's'}"><a data-sym="${s}">${s}</a></td>`;
    const yes = (v) => v ? '✓' : '✕', usdc = (v, d = 2) => `${fmt(v, d)} <span class="mut">USD</span>`;
    if (k === 'orders') {
      const list = a.orders.filter(o => o.status === 'open' && symShown(o.symbol, true)).sort(byTime);
      const head = [ckAll(list.map(o => 'o' + o.id)), 'Symbol', 'Qty (Lot)', 'Filled (Lot)', 'Size', 'Notional', 'Type', 'Reduce Only', 'Limit Price', 'Execution Price', '<span class="dl">TP / SL</span>', 'Time', 'Action'];
      return chips(sorting) + tbl(head, list.map(o => {
        const p = Feed.products[o.symbol], rem = o.size - o.filled;
        return `<tr><td>${ck('o' + o.id)}</td>${sym(o.symbol, o.side)}<td><a class="ul ${o.side === 'buy' ? 'buy' : 'sell'}" data-act="oqty" data-id="${o.id}">${fmt(o.size, 0)}</a></td><td>${fmt(o.filled, 0)}</td>
          <td>${baseQty(p, o.size)}</td><td>${usdc(notionalOf(o.symbol, rem, o.price))}</td><td>${typeLbl(o.type)}</td><td>${yes(o.reduceOnly)}</td>
          <td><a class="ul buy" data-act="opx" data-id="${o.id}">${o.price ? o.price.toFixed(p.dp) : '-'}</a></td><td>${o.filled ? o.avg.toFixed(p.dp) : '-'}</td>
          <td>${o.tp || o.sl ? `<a class="otp" data-act="otpsl" data-id="${o.id}">TP ${o.tp ? num1(o.tp, 2) : '-'} / SL ${o.sl ? num1(o.sl, 2) : '-'} ✎</a>` : `<a class="oadd" data-act="otpsl" data-id="${o.id}">+ Add</a>`}</td>
          <td>${dayCell(o.ts, true)}</td><td><button class="pclose" data-act="cx" data-id="${o.id}" title="Cancel order">✕</button></td></tr>`;
      }), 'No open orders');
    }
    if (k === 'stops') {
      const list = stopRows().filter(r => symShown(r.sym, true)).sort(byTime);
      const head = [ckAll(list.map(r => r.key)), 'Symbol', 'Qty (Lot)', 'Size', 'Notional', 'Trigger Price', 'Trigger Index', 'Triggering Price', 'Type', 'Limit Price', 'Reduce Only', 'Status', 'Time', 'Action'];
      return chips(sorting) + tbl(head, list.map(r => {
        const p = Feed.products[r.sym], o = r.o, opt = p.kind !== 'perp';
        const trig = o ? o.stop : r.trig, cond = o ? (o.dir === 'up' ? '>=' : '<=') : (r.above ? '>=' : '<=');
        const btrig = r.pos ? (r.pos.tpslTrig || (opt ? 'index' : 'mark')) : null;
        const idxName = o ? (o.trigger === 'last' ? 'Last Price' : 'Mark Price') : (btrig === 'index' ? 'Index Price' : 'Mark Price');
        const now = o ? (o.trigger === 'last' ? (Feed.tickers[r.sym] || {}).last : (Feed.tickers[r.sym] || {}).mark) : Engine.tpslRef(r.sym, btrig);
        const type = o ? typeLbl(o.type) : (r.leg === 'tp' ? 'Bracket - TP' : 'Bracket - SL');
        return `<tr><td>${ck(r.key)}</td>${sym(r.sym, r.side)}<td>${lotsSigned(r.side, r.lots)}</td><td class="buy">${baseQty(p, r.lots)}</td><td>${usdc(notionalOf(r.sym, r.lots, trig))}</td>
          <td>${cond}<a class="ul" data-act="ostop" data-key="${r.key}">${num1(trig, 2)}</a></td><td>${idxName}</td><td>${now ? num1(now, 2) : '-'}</td><td>${type}</td>
          <td>${o && o.price ? o.price.toFixed(p.dp) : r.pos && r.pos[r.leg + 'Lim'] ? (+r.pos[r.leg + 'Lim']).toFixed(p.dp) : '-'}</td><td>${yes(o ? o.reduceOnly : true)}</td><td>Untriggered</td><td>${dayCell(r.ts)}</td>
          <td><button class="pclose" data-act="scx" data-key="${r.key}" title="Cancel">✕</button></td></tr>`;
      }), 'No stop orders');
    }
    if (k === 'fills') {
      const head = ['Symbol', 'Fill Qty (Lot)', 'Side', 'Order Qty (Lot)', 'Execution Price', 'Notional', '<span class="dl">Size</span>', 'Fill Type', 'Order Type', 'Role', 'Order ID', 'Fill ID', 'Time'];
      return chips() + tbl(head, tableData('fills').map(({ f, p, nt, otype, oqty, ftype, role }) => `<tr>${sym(f.symbol, f.side)}<td>${lotsSigned(f.side, f.size)}</td>
        <td class="${f.side === 'buy' ? 'buy' : 'sell'}">${f.side === 'buy' ? 'Buy' : 'Sell'}</td><td>${lotsSigned(f.side, oqty)}</td><td>${(+f.price).toFixed(p.dp)}</td><td>${usdc(nt, 4)}</td>
        <td class="${f.side === 'buy' ? 'buy' : 'sell'}">${f.side === 'buy' ? '+' : '-'}${baseQty(p, f.size)}</td><td>${ftype}</td><td>${typeLbl(otype)}</td><td>${role}</td>
        <td>${f.orderId || '-'}</td><td class="mut" title="${esc(f.id)}">${esc(String(f.id).slice(0, 5).toUpperCase())}...</td><td>${dayCell(f.ts)}</td></tr>`), 'No fills yet');
    }
    if (k === 'history') {
      const head = ['Symbol', 'Qty (Lot)', 'Side', 'Status', 'Filled (Lot)', 'Order Type', 'Limit Price', 'Trigger Price', 'Execution Price', '<span class="dl">Size</span>', 'Cashflow', 'Realized PnL', 'Trading Fees (Inc. GST)', 'Net PnL (USD)', 'Order ID', 'Reduce-Only', 'Share', 'Time'];
      return chips() + tbl(head, tableData('history').map(({ o, p, pnl, fee, closing, cash, st }) => `<tr>${sym(o.symbol, o.side)}<td>${lotsSigned(o.side, o.size)}</td>
        <td class="${o.side === 'buy' ? 'buy' : 'sell'}">${closing ? 'Close' : 'Open'} ${o.side === 'buy' ? 'Buy' : 'Sell'}</td><td class="${st === 'Filled' ? 'buy' : 'mut'}">${st}</td><td>${fmt(o.filled, 0)}</td>
        <td>${typeLbl(o.type)}</td><td>${o.price ? o.price.toFixed(p.dp) : '-'}</td><td>${o.stop ? o.stop.toFixed(p.dp) : '-'}</td><td>${o.filled ? (+o.avg).toFixed(p.dp) : '-'}</td>
        <td class="${o.side === 'buy' ? 'buy' : 'sell'}">${o.side === 'buy' ? '+' : '-'}${baseQty(p, o.size)}</td><td>${usdc(cash)}</td><td>${usdc(pnl + fee)}</td><td>${usdc(fee)}</td><td>${usdc(pnl)}</td>
        <td>${o.id}</td><td>${yes(o.reduceOnly)}</td><td><button class="ib" data-act="hshare" data-id="${o.id}" title="Copy order">${IC_SHARE}</button></td><td class="nowrap">${histTime(o.ts)}</td></tr>`), 'No order history');
    }
    // Risk & Margin Details: status, initial and maintenance margin (with % of equity)
    const s = Engine.summary(a), im = s.posMargin + s.ordMargin, mm = Engine.maintenance(a), pc = (v) => s.equity > 0 ? ` <span class="mut">(${(v / s.equity * 100).toFixed(2)}%)</span>` : '';
    const ratio = s.equity > 0 ? mm / s.equity : 1, health = ratio < 0.5 ? ['buy', 'Healthy'] : ratio < 1 ? ['acc', 'At Risk'] : ['sell', 'Liquidation'];
    return `<table class="rtbl"><thead><tr><th>Status</th><th><span class="dl">Initial Margin</span></th><th class="r"><span class="dl">Maintenance Margin</span></th></tr></thead>
      <tbody><tr><td><span class="dl ${health[0]}">${health[1]}</span></td><td><b>$${fmt(im)}</b>${pc(im)}</td><td class="r"><b>$${fmt(mm)}</b>${pc(mm)}</td></tr></tbody></table>`;
  }
  const IC_SHARE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="8" r="2"/><circle cx="12" cy="3.5" r="2"/><circle cx="12" cy="12.5" r="2"/><path d="M5.8 7l4.4-2.5M5.8 9l4.4 2.5"/></svg>';
  $('#botView').addEventListener('change', (e) => {
    if (e.target.matches('[data-sort-ord]')) { ui.ordAsc = e.target.value === 'asc'; dirty(true); }
    if (e.target.matches('[data-pgsz]')) { ui.pageSize = +e.target.value; ui.pages = {}; saveUi(); dirty(true); }
    if (e.target.tagName === 'SELECT') e.target.blur();
  });
  /* Live redraws patch the table in place: only changed text / attributes are touched, so buttons, checkboxes
     and open dropdowns stay the same elements (steady hover, no lost clicks, dropdowns stay open). */
  function morph(el, html) { const t = document.createElement('template'); t.innerHTML = html; morphKids(el, t.content); }
  function morphKids(a, b) {
    const an = [...a.childNodes], bn = [...b.childNodes];
    bn.forEach((y, i) => an[i] ? morphNode(an[i], y) : a.appendChild(y));
    for (let i = an.length - 1; i >= bn.length; i--) an[i].remove();
  }
  function morphNode(x, y) {
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) return x.replaceWith(y);
    if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; return; }
    if (x === document.activeElement && (x.tagName === 'SELECT' || x.tagName === 'INPUT')) return; // the user is using it
    for (const at of [...x.attributes]) if (!y.hasAttribute(at.name)) x.removeAttribute(at.name);
    for (const at of [...y.attributes]) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
    if (x.tagName === 'INPUT') { if (x.type === 'checkbox') x.checked = y.hasAttribute('checked'); else if (x.value !== y.value) x.value = y.value; return; }
    morphKids(x, y);
    if (x.tagName === 'SELECT') { const v = (y.querySelector('option[selected]') || y.options[0] || {}).value; if (v != null && x.value !== v) x.value = v; }
  }
  $('#botView').onclick = async (e) => {
    const pf = e.target.closest('[data-pf]'); if (pf) { ui.posFilter = pf.dataset.pf; ui.pages = {}; return dirty(true); }
    const pg = e.target.closest('[data-pg]'); if (pg && !pg.disabled) { ui.pages[ui.botTab] = (ui.pages[ui.botTab] || 1) + +pg.dataset.pg; $('#botView').scrollTop = 0; return dirty(true); }
    const sym = e.target.closest('[data-sym]'); if (sym) return selectSymbol(sym.dataset.sym);
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const a = Engine.active, s = b.dataset.s;
    if (b.dataset.act === 'ccy') return ccyMenu(b);
    if (b.dataset.act === 'psort') { ui.posAsc = !ui.posAsc; return dirty(true); }
    if (b.dataset.act === 'ock') { if (b.checked) ui.ordOff.delete(b.dataset.key); else ui.ordOff.add(b.dataset.key); return dirty(true); }
    if (b.dataset.act === 'ockall') { b.dataset.keys.split(' ').filter(Boolean).forEach(x => b.checked ? ui.ordOff.delete(x) : ui.ordOff.add(x)); return dirty(true); }
    if (b.dataset.act === 'oqty' || b.dataset.act === 'opx') {
      const o = a.orders.find(x => x.id === +b.dataset.id); if (!o) return;
      const isQty = b.dataset.act === 'oqty';
      return ask(`Edit ${o.symbol} order`, [{ k: 'v', label: isQty ? `Quantity (Lot) – ${o.filled} filled` : 'Limit price (USD)', value: isQty ? o.size : o.price }],
        async (v) => { const r = await Engine.amendOrder(a, o.id, isQty ? { size: +v.v } : { price: +v.v }); r.ok ? toast('success', `Your ${o.symbol} order has been updated.`, 'Order Updated') : toast('error', r.error, 'Order Rejected'); }, { ok: 'Save' });
    }
    if (b.dataset.act === 'otpsl') return bracketDialog({ id: +b.dataset.id });
    if (b.dataset.act === 'ostop') {
      const r = stopRows().find(x => x.key === b.dataset.key); if (!r) return;
      if (!r.o) return bracketDialog({ sym: r.sym });
      return ask(`Edit ${r.sym} stop order`, [{ k: 'v', label: 'Trigger price (USD)', value: r.o.stop }], async (v) => { const res = await Engine.amendOrder(a, r.o.id, { stop: +v.v }); res.ok ? toast('success', 'Trigger updated') : toast('error', res.error); }, { ok: 'Save' });
    }
    if (b.dataset.act === 'scx') { const r = stopRows().find(x => x.key === b.dataset.key); if (r) await cancelRow(r); return; }
    if (b.dataset.act === 'hshare') {
      const o = a.history.find(x => x.id === +b.dataset.id); if (!o) return;
      const txt = `${o.symbol} ${o.side.toUpperCase()} ${o.filled}/${o.size} lots @ ${o.avg ? (+o.avg).toFixed(dp(o.symbol)) : '-'} | net PnL ${sgn(orderPnl(o).pnl)} USD (Delta Demo)`;
      try { await navigator.clipboard.writeText(txt); toast('success', 'Order copied to clipboard'); } catch (_) { toast('info', txt); }
      return;
    }
    if (b.dataset.act === 'pck') { if (b.checked) ui.posOff.delete(s); else ui.posOff.add(s); return dirty(true); }
    if (b.dataset.act === 'pckall') { shownPositions().forEach(([x]) => b.checked ? ui.posOff.delete(x) : ui.posOff.add(x)); return dirty(true); }
    if (b.dataset.act === 'close') return closeDialog(s);
    if (b.dataset.act === 'tpclr') { const r = await Engine.setTpSl(a, s, null, null); return r.ok ? toast('error', `Your Bracket - TP / SL orders in ${s} have been cancelled.`, 'Order Cancelled') : toast('error', r.error); }
    if (b.dataset.act === 'share') {
      const pos = a.positions[s], p = Feed.products[s], u = Engine.upnl(pos, s);
      const txt = `${s} ${pos.size > 0 ? 'LONG' : 'SHORT'} ${(Math.abs(pos.size) * p.cv).toFixed(decOf(p.cv))} ${p.unit || p.base} @ ${pos.entry.toFixed(p.dp)} | UPNL ${sgn(u)} USD (Delta Demo)`;
      try { await navigator.clipboard.writeText(txt); toast('success', 'Position copied to clipboard'); } catch (_) { toast('info', txt); }
      return;
    }
    if (b.dataset.act === 'cx') { const o = a.orders.find(x => x.id === +b.dataset.id); if (o) cancelOrder(o); }
    if (b.dataset.act === 'cm') { const r = await Engine.closePosition(a, s, 'market'); if (!r.ok) toast('error', r.error); }
    if (b.dataset.act === 'cl') ask(`Close ${s} at limit`, [{ k: 'price', label: 'Limit price', value: (Feed.tickers[s] || {}).last || '' }], async (v) => { const r = await Engine.closePosition(a, s, 'limit', +v.price); if (!r.ok) toast('error', r.error); });
    if (b.dataset.act === 'tpsl') bracketDialog({ sym: s });
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
  const IC = {
    edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3L5 14H2v-3z"/><path d="M9 4l3 3"/></svg>',
    reset: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v3h3"/></svg>',
    del: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11"/><path d="M6 4V2.5h4V4"/><path d="M4 4l.7 9.5h6.6L12 4"/><path d="M6.8 7v4M9.2 7v4"/></svg>',
  };
  const initial = (n) => esc((n.trim()[0] || '?').toUpperCase());
  function renderProfMenu() {
    const list = Engine.state.accounts, act = Engine.active, s = Engine.summary(act), pnl = s.equity - act.initial, one = list.length < 2;
    $('#profMenu').innerHTML = `<div class="pm-head"><span class="avatar big" style="${avatarStyle(act.name)}">${initial(act.name)}</span>
        <div class="pm-who"><b>${esc(act.name)}</b><small>Demo account · paper trading</small></div></div>
      <div class="pm-stats"><div><small>Equity</small><b>${fmt(s.equity)}</b></div><div><small>Available</small><b>${fmt(s.available)}</b></div><div><small>Total PnL</small><b class="${cls(pnl)}">${sgn(pnl)}</b></div></div>
      <div class="pm-sec"><span>Accounts</span><span class="pm-cnt">${list.length}</span></div>
      <div class="pm-list">${list.map(a => { const q = Engine.summary(a), p = q.equity - a.initial; return `<div class="pm-row ${a.id === act.id ? 'on' : ''}" data-sw="${a.id}" title="${a.id === act.id ? 'Current account' : 'Switch to ' + esc(a.name)}">
          <span class="avatar sm" style="${avatarStyle(a.name)}">${initial(a.name)}</span>
          <div class="pm-n"><b>${esc(a.name)}</b><small>${fmt(q.equity)} USD · <span class="${cls(p)}">${sgn(p)}</span></small></div>
          <div class="pm-act"><button data-pa="ed" data-id="${a.id}" title="Edit name and balance">${IC.edit}</button><button data-pa="rs" data-id="${a.id}" title="Reset account">${IC.reset}</button>
            <button data-pa="dl" data-id="${a.id}" class="dng" title="${one ? 'Keep at least one account' : 'Delete account'}" ${one ? 'disabled' : ''}>${IC.del}</button></div></div>`; }).join('')}</div>
      <button class="pm-new" data-pa="new">+ New account</button>`;
  }
  $('#hdrAcct').addEventListener('click', (e) => {
    if (e.target.closest('#profBtn')) { const m = $('#profMenu'); if (m.classList.contains('hidden')) { renderProfMenu(); m.classList.remove('hidden'); } else m.classList.add('hidden'); }
  });
  $('#hdrAcct').addEventListener('mousedown', (e) => {
    const m = $('#profMenu'); if (!m || !e.target.closest('#profMenu')) return;
    const pa = e.target.closest('[data-pa]');
    if (pa) {
      if (pa.disabled) return;
      m.classList.add('hidden'); const id = pa.dataset.id;
      return ({ ed: () => acctEdit(id), rs: () => acctReset(id), dl: () => acctDelete(id), new: newAccountDialog })[pa.dataset.pa]();
    }
    const sw = e.target.closest('[data-sw]');
    if (sw) { m.classList.add('hidden'); if (sw.dataset.sw !== Engine.active.id) { Engine.switchAccount(sw.dataset.sw); toast('info', `You are now trading in ${Engine.active.name}.`, 'Account Switched'); } }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.prof')) { const m = $('#profMenu'); if (m) m.classList.add('hidden'); } });
  const acct = (id) => Engine.state.accounts.find(x => x.id === id);
  function acctEdit(id) {
    const a = acct(id);
    ask('Edit account', [{ k: 'name', label: 'Name', value: a.name, text: true }, { k: 'bal', label: 'Wallet balance (USD)', value: +a.balance.toFixed(2) }], async v => {
      const name = v.name.trim(), bal = +v.bal;
      if (!name) return toast('error', 'Name cannot be empty');
      if (name !== a.name) await Engine.renameAccount(id, name);
      if (Math.abs(bal - a.balance) > 1e-9) { const r = await Engine.setBalance(id, bal); if (!r.ok) return toast('error', r.error); }
      toast('success', 'Account updated');
    }, { ok: 'Save', note: 'Changing the balance keeps your PnL history.' });
  }
  function acctReset(id) {
    const a = acct(id);
    ask(`Reset "${a.name}"`, [{ k: 'bal', label: 'Start again with (USD)', value: a.initial }],
      async v => { await Engine.resetAccount(id, +v.bal); toast('info', `${a.name} reset`); }, { ok: 'Reset', note: 'Clears all positions, open orders, fills and history.' });
  }
  function acctDelete(id) {
    const a = acct(id);
    ask(`Delete "${a.name}"?`, [], async () => { const r = await Engine.deleteAccount(id); if (!r.ok) return toast('error', r.error); toast('info', `${a.name} deleted`); },
      { ok: 'Delete', danger: true, note: 'Its positions, orders and history are removed permanently. This cannot be undone.' });
  }
  function newAccountDialog() {
    ask('New account', [{ k: 'name', label: 'Account name', value: `Account ${Engine.state.accounts.length + 1}`, text: true }, { k: 'bal', label: 'Starting balance (USD)', value: 10000 }],
      async (v) => { const r = await Engine.createAccount(v.name, +v.bal); if (!r.ok) return toast('error', r.error); toast('success', `Created ${Engine.active.name}`); }, { ok: 'Create' });
  }

  /* ================= modals / toasts ================= */
  function modal(html) { $('#mbox').innerHTML = html; $('#modal').classList.remove('hidden'); }
  function closeModal() { $('#modal').classList.add('hidden'); $('#mbox').onclick = null; }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  function ask(title, fields, cb, o = {}) {
    modal(`<h3>${esc(title)} <button class="x" data-close>×</button></h3>` + (o.note ? `<div class="mnote">${esc(o.note)}</div>` : '') + fields.map(f => `<div class="fld" style="margin-top:10px"><label>${esc(f.label)}</label><div class="inp"><input data-k="${f.k}" value="${esc(f.value)}" ${f.text ? '' : 'inputmode="decimal"'}></div></div>`).join('') +
      `<div class="mrow" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn ${o.danger ? 'del' : 'pri'}" id="askOk">${esc(o.ok || 'Confirm')}</button></div>`);
    const go = () => { const v = {}; $('#mbox').querySelectorAll('input[data-k]').forEach(i => v[i.dataset.k] = i.value); closeModal(); cb(v); };
    $('#askOk').onclick = go;
    $('#mbox').onclick = (e) => { if (e.target.closest('[data-close]')) closeModal(); };
    $('#mbox').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    const first = $('#mbox input'); if (first) { first.focus(); first.select(); } else $('#askOk').focus();
  }
  const TOAST_TITLE = { success: 'Success', error: 'Error', info: 'Info' };
  function toast(type, msg, title) {
    const el = document.createElement('div'); el.className = 'toast ' + type;
    el.innerHTML = `<div class="tt"><b></b><button class="tx" title="Dismiss">×</button></div><div class="tm"></div>`;
    el.querySelector('b').textContent = title || TOAST_TITLE[type] || 'Info'; el.querySelector('.tm').textContent = msg;
    el.querySelector('.tx').onclick = () => el.remove();
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, 5000); while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  }

  /* ================= wiring & render loop ================= */
  let pending = false, force = false, lastBot = 0, lastChain = 0;
  function dirty(f) { force = force || !!f; if (!pending) { pending = true; requestAnimationFrame(frame); setTimeout(frame, 80); } }
  function frame() {
    if (!pending) return;
    pending = false;
    renderStats(); renderBook(); renderPicker();
    updateOrderDyn(); renderAcct(); if (isMob()) renderMobile();
    if (!optView() || ui.optMode === 'chart') { if (curSrc() === 'depth') drawDepth(); else renderOneClick(); }
    const now = performance.now();
    if (ui.view === 'options' && ui.optMode === 'chain' && now - lastChain > 400) { renderChainTbl(); lastChain = now; }
    if (force || now - lastBot > 250) {
      renderBotTabs(); const bv = $('#botView'), h = botHtml();
      if (h !== bv._h) { const st = bv.scrollTop; morph(bv, h); bv._h = h; bv.scrollTop = st; }
      lastBot = now; force = false;
    }
  }
  Feed.on('ticker', (s) => { if (s === ui.sym || (Engine.active && Engine.active.positions[s]) || ui.view === 'options') dirty(); });
  Feed.on('book', (s) => { if (s === ui.sym) dirty(); });
  Feed.on('trade', (s) => { if (s === ui.sym) dirty(); });
  Feed.on('trades', (s) => { if (s === ui.sym) dirty(); });
  Feed.on('status', () => { const el = $('#feedWarn'); el.classList.toggle('hidden', Feed.status === 'live'); el.textContent = Feed.status === 'connecting' ? 'Connecting…' : 'Market feed reconnecting…'; }); // shown only when the feed is down
  Engine.onChange((kind, p) => {
    if (kind === 'fill' && p) {
      const f = p.order, who = p.acct.id === Engine.active.id ? '' : `[${p.acct.name}] `;
      toast('success', `${who}Your ${f.side} order of ${fmt(p.qty, 0)} lots in ${f.symbol} was filled at ${(+p.px).toFixed(dp(f.symbol))}.`, 'Order Filled');
      return;
    }
    if (kind === 'toast') return toast(p.type, p.msg, p.title);
    if (kind === 'conn') return connToast();
    if (kind === 'accounts') renderOrderPanel();
    updateInterest(); refreshLines(); dirty(true);
  });
  /* quick reconnects stay silent: only say the connection was lost if it isn't back within 4s */
  let connTimer = null, lostShown = false;
  function connToast() {
    if (!Client.connected) {
      if (!connTimer && !lostShown) connTimer = setTimeout(() => { connTimer = null; if (!Client.connected) { lostShown = true; toast('error', 'Trying to reconnect to the server…', 'Connection Lost'); } }, 4000);
      return;
    }
    if (connTimer) { clearTimeout(connTimer); connTimer = null; }
    if (lostShown) { lostShown = false; toast('success', 'You are connected to the server again.', 'Reconnected'); }
  }
  setInterval(() => dirty(), 1000);
  window.addEventListener('resize', () => dirty());

  /* ================= phones and small tablets: Delta's mobile app layout (≤ 900px) ================= */
  const MQ = window.matchMedia('(max-width: 900px)');
  function isMob() { return MQ.matches; }
  const MTABS = [['markets', 'Markets', '<path d="M7 3v18M17 3v18"/><rect x="4.5" y="7" width="5" height="9" rx="1"/><rect x="14.5" y="6" width="5" height="7" rx="1"/>'],
    ['trade', 'Trade', '<circle cx="12" cy="12" r="8"/><path d="M12 8l4 4-4 4-4-4z"/>'], ['charts', 'Charts', '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M7 15l3.5-4 3 2.5L17 9"/>'],
    ['portfolio', 'Portfolio', '<path d="M4 8h16v11H4z"/><path d="M9 8V5h6v3"/>']];
  const MK_TABS = [['watch', 'Watchlist'], ['futures', 'Futures'], ['options', 'Options'], ['rwa', 'RWA Tokens']];
  function setMTab(t) {
    ui.mtab = t;
    if (ui.view === 'options') { const want = t === 'charts' ? 'chart' : 'chain'; if (ui.optMode !== want) { ui.optMode = want; applyView(); } }
    applyMobile(); scrollTo(0, 0);
  }
  function applyMobile() {
    const m = isMob(), b = document.body.classList;
    if (ui.view !== 'options' && ui.mk === 'options') ui.mk = 'futures'; // Markets follows the view you're on
    b.toggle('mob', m);
    for (const [t] of MTABS) b.toggle('mt-' + t, m && ui.mtab === t);
    b.toggle('mk-opt', m && ui.mtab === 'markets' && ui.mk === 'options');
    if (!m) return;
    $('#mnav').innerHTML = MTABS.map(([k, l, ic]) => `<a data-mt="${k}" class="${k === ui.mtab ? 'on' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${ic}</svg>${l}</a>`).join('');
    renderMobile();
  }
  function renderMobile() {
    const p = P(), t = T(); if (!p) return;
    // Markets: Watchlist / Futures / Options / RWA Tokens; Options shows the T-shape chain
    $('#mMk').innerHTML = `<div class="pk-tabs">${MK_TABS.map(([k, l]) => `<a data-mk="${k}" class="${k === ui.mk ? 'on' : ''}">${l}</a>`).join('')}</div>` + (ui.mk === 'options' ? '' :
      `<div class="mk-head"><span>Name</span><span>Last Price/ Vol.</span><span>24h Chg.</span></div><div class="mk-list">${marketList(ui.mk, '').map(x => {
        const q = Feed.products[x], k = Feed.tickers[x] || {}, ch = k.open ? (k.last - k.open) / k.open * 100 : 0;
        return `<div class="mk-row" data-ms="${x}"><span class="star ${watch.has(x) ? 'on' : ''}" data-w="${x}">${watch.has(x) ? '★' : '☆'}</span>
          <span class="mk-n"><b>${esc(x)}</b> <i class="levb">${q.maxLev}x</i><small>${esc(q.shortDesc || q.desc)}</small></span>
          <span class="mk-p"><b>${usd(k.last, q.dp)}</b><small>$${compact(k.volUsd || 0)}</small></span><span class="${cls(ch)}">${ch.toFixed(2)}%</span></div>`;
      }).join('') || `<div class="empty">${ui.mk === 'watch' ? 'Tap ☆ on a market to add it to your watchlist' : 'No markets'}</div>`}</div>`);
    // symbol bar over Trade / Charts
    const px = t.last || t.mark, ch = t.open && px ? (px - t.open) / t.open * 100 : 0, opt = p.kind !== 'perp', usdM = (v) => '$' + ((v || 0) / 1e6).toFixed(1) + 'M';
    const sub = opt ? `${p.under} ${p.kind === 'call' ? 'Call' : 'Put'}` : (p.shortDesc || p.desc);
    const ms = Math.max(0, Engine.nextFunding() - Date.now()), fc = `${z2(Math.floor(ms / 3.6e6))}h:${z2(Math.floor(ms % 3.6e6 / 6e4))}m:${z2(Math.floor(ms % 6e4 / 1e3))}s`;
    const stats = opt ? [['Index Price', '$' + num1(Engine.spotOf(ui.sym), 1)], ['24h Vol.', usdM(t.volUsd)], ['OI', usdM(t.oiUsd)]]
      : [['24h Vol.', usdM(t.volUsd)], ['OI', usdM(t.oiUsd)], ['Funding (8h)', `${((t.funding || 0) * 100).toFixed(4)}% / ${fc}`]];
    $('#mBar').innerHTML = `<div class="mb1"><span class="star ${watch.has(ui.sym) ? 'on' : ''}" data-w="${ui.sym}">${watch.has(ui.sym) ? '★' : '☆'}</span>
        <a class="mb-sym" data-msym><b>${esc(p.symbol)} <span class="car">⌄</span></b><small>${esc(sub)}</small></a>
        <span class="mb-px ${lastDir}"><b>${usd(px, p.dp)} ${lastDir === 'sell' ? '↓' : '↑'}</b><small class="${cls(ch)}">${ch.toFixed(2)}%</small></span></div>
      <div class="mb2">${stats.map(([l, v]) => `<div><small>${l}</small><b>${v}</b></div>`).join('')}<span class="sp"></span>
        <a class="mb-go" data-mt="${ui.mtab === 'charts' ? 'trade' : 'charts'}">${ui.mtab === 'charts' ? 'Trade' : 'Chart'}</a></div>`;
    // Portfolio: account summary over the positions tables
    const a = Engine.active, sm = Engine.summary(a), pnl = sm.equity - a.initial;
    $('#mPort').innerHTML = `<div class="pm-stats"><div><small>Equity</small><b>${fmt(sm.equity)}</b></div><div><small>Available</small><b>${fmt(sm.available)}</b></div><div><small>Unrealised PnL</small><b class="${cls(sm.upnl)}">${sgn(sm.upnl)}</b></div><div><small>Total PnL</small><b class="${cls(pnl)}">${sgn(pnl)}</b></div></div>`;
  }
  document.addEventListener('click', (e) => {
    if (!isMob()) return;
    const w = e.target.closest('#mMk [data-w], #mBar [data-w]'); if (w) { toggleWatch(w.dataset.w); renderMobile(); return; }
    const mt = e.target.closest('[data-mt]'); if (mt) return setMTab(mt.dataset.mt);
    if (e.target.closest('[data-msym]')) { ui.mk = P().kind === 'perp' ? 'futures' : 'options'; return setMTab('markets'); }
    const mk = e.target.closest('[data-mk]'); if (mk) { ui.mk = mk.dataset.mk; if (ui.mk === 'options' && ui.view !== 'options') setView('options'); ui.optMode = 'chain'; applyView(); return applyMobile(); }
    const row = e.target.closest('[data-ms]'); if (row) { selectSymbol(row.dataset.ms); return setMTab('charts'); }
  });
  // switching between phone and desktop widths re-lays out the page
  MQ.addEventListener('change', () => { if (!isMob() && ui.view === 'options') ui.optMode = 'chain'; applyView(); applyMobile(); renderOrderPanel(); if (ui.view === 'options') { renderChainBar(); renderChainTbl(true); } dirty(true); });

  /* ================= boot ================= */
  if (ui.view === 'options' && unders().length) { if (!unders().includes(ui.under)) ui.under = unders()[0]; ensureExpiry(); if (!ui.opt || !Feed.products[ui.opt]) ui.opt = pickAtm(); ui.sym = ui.opt; }
  else { ui.view = 'futures'; ui.sym = ui.perp; }
  renderOrderPanel(); updateInterest(); applyView(); applyMobile(); dirty(true);
  Feed.emit('status');
  requestAnimationFrame(() => { const b = $('#boot'); b.classList.add('done'); setTimeout(() => b.remove(), 450); });
})();
