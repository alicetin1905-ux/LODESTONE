// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-gray; icon-glyph: chart-bar;
// LODESTONE iPhone widget for Scriptable · https://alicetin1905-ux.github.io/LODESTONE/

// liqmap-core.js — estimated liquidation map from 15m klines + 15m open interest.
// Pure function (no network, no DOM): the same source runs in the Node tests and in the browser.
//
// Model
//  - Every 15m candle where open interest ROSE = new leveraged positions, opened at the candle VWAP.
//    Split long/short by candle direction (aggressor side gets up to 75%).
//  - Each new position is spread over leverage tiers; liq price uses Bybit's isolated formula
//    long = entry*(1 - 1/L + MMR), short = entry*(1 + 1/L - MMR), L capped at the symbol's max leverage.
//  - Candles where open interest FELL close positions pro-rata (everything shrinks by OI_after/OI_before).
//  - A level that price has traded through since the position was opened is gone (already liquidated).
//  - What is left is binned (0.1% of price), smoothed, and scanned for peaks above and below price.
function liqMap(candles, oiByTs, p) {
  const N = candles.length;
  const price = p.price != null ? p.price : candles[N - 1].c;

  // lowest low / highest high from candle i to now (sweep check)
  const sufMin = new Float64Array(N + 1).fill(Infinity);
  const sufMax = new Float64Array(N + 1).fill(-Infinity);
  for (let i = N - 1; i >= 0; i--) {
    sufMin[i] = Math.min(sufMin[i + 1], candles[i].l);
    sufMax[i] = Math.max(sufMax[i + 1], candles[i].h);
  }

  // births (OI up) and cumulative pro-rata closing factor (OI down), per venue.
  // oiByTs is one Map (timestamp -> open interest in the candle's coin units) or an array of them, one per exchange.
  const venues = oiByTs instanceof Map ? [oiByTs] : oiByTs;
  const Cv = venues.map(() => new Float64Array(N));
  let matched = 0;
  const births = [];
  venues.forEach((oi, v) => {
    const C = Cv[v];
    let cum = 1;
    for (let i = 0; i < N; i++) {
      const k = candles[i];
      const a = oi.get(k.t), b = oi.get(k.t + p.stepMs);
      if (a > 0 && b > 0) {
        if (v === 0) matched++;
        const d = b - a;
        if (d > 0) {
          const vwap = k.v > 0 && k.q > 0 ? k.q / k.v : (k.h + k.l + k.c) / 3;
          const rng = k.h - k.l;
          const dir = rng > 0 ? (k.c - k.o) / rng : 0;
          births.push({ i, v, e: vwap, n: d * vwap, wL: 0.5 + 0.25 * dir });
        } else if (d < 0) {
          cum *= b / a;
        }
      }
      C[i] = cum;
    }
  });

  const tiers = p.tiers.map(([L, w]) => [Math.min(L, p.maxLev), w]);
  const bw = price * p.binPct;
  const half = Math.round(p.rangePct / p.binPct);
  const nb = 2 * half + 1;
  const lo = price - half * bw; // bin j centre = lo + j*bw ; current price sits at j = half
  const LH = new Float64Array(nb), SH = new Float64Array(nb);
  for (const B of births) {
    const surv = Cv[B.v][N - 1] / Cv[B.v][B.i];
    const mn = sufMin[B.i + 1], mx = sufMax[B.i + 1];
    for (const [L, w] of tiers) {
      const lq = B.e * (1 - 1 / L + p.mmr);
      const sq = B.e * (1 + 1 / L - p.mmr);
      if (lq < mn) {
        const j = Math.round((lq - lo) / bw);
        if (j >= 0 && j < half) LH[j] += B.n * B.wL * w * surv;
      }
      if (sq > mx) {
        const j = Math.round((sq - lo) / bw);
        if (j > half && j < nb) SH[j] += B.n * (1 - B.wL) * w * surv;
      }
    }
  }

  // gaussian smoothing
  const smooth = (H) => {
    const s = p.sigmaBins, r = Math.ceil(3 * s);
    const ker = [];
    let tot = 0;
    for (let x = -r; x <= r; x++) { const v = Math.exp(-(x * x) / (2 * s * s)); ker.push(v); tot += v; }
    const out = new Float64Array(H.length);
    for (let j = 0; j < H.length; j++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) { const q = j + x; if (q >= 0 && q < H.length) acc += H[q] * ker[x + r]; }
      out[j] = acc / tot;
    }
    return out;
  };
  const LS = smooth(LH), SS = smooth(SH);
  const lim = Math.round(p.searchPct / p.binPct);

  const scan = (S, H, sign) => {
    // bins on this side of price, within searchPct
    const first = sign > 0 ? half + 1 : half - lim;
    const last = sign > 0 ? half + lim : half - 1;
    const peaks = [];
    for (let j = Math.max(1, first); j <= Math.min(nb - 2, last); j++) {
      const v = S[j];
      if (!(v > 0)) continue;
      let isMax = true;
      for (let q = Math.max(0, j - p.peakWin); q <= Math.min(nb - 1, j + p.peakWin); q++) {
        if (S[q] > v || (S[q] === v && q < j)) { isMax = false; break; }
      }
      if (isMax) peaks.push(j);
    }
    let total = 0;
    for (let j = Math.max(0, first); j <= Math.min(nb - 1, last); j++) total += H[j];
    if (!peaks.length) return { nearest: null, major: null, peaks: [], total };
    const M = Math.max(...peaks.map((j) => S[j]));
    const info = (j) => {
      const th = S[j] * p.zoneFrac;
      let a = j, b = j;
      // zone = this peak's own hill: walk outwards while the profile keeps falling and stays above half the peak
      while (a - 1 >= first && S[a - 1] >= th && S[a - 1] <= S[a]) a--;
      while (b + 1 <= last && S[b + 1] >= th && S[b + 1] <= S[b]) b++;
      let size = 0;
      for (let q = a; q <= b; q++) size += H[q];
      const px = lo + j * bw;
      return { px, zlo: lo + a * bw, zhi: lo + b * bw, dist: (px / price - 1) * 100, rel: S[j] / M, size };
    };
    const byDist = peaks.slice().sort((x, y) => Math.abs(x - half) - Math.abs(y - half));
    const nearestJ = byDist.find((j) => S[j] >= p.sigFrac * M);
    const majorJ = peaks.reduce((m, j) => (S[j] > S[m] ? j : m), peaks[0]);
    return { nearest: info(nearestJ), major: info(majorJ), peaks: byDist.map(info), total };
  };

  return {
    price,
    up: scan(SS, SH, +1),   // short liquidations above price
    down: scan(LS, LH, -1), // long liquidations below price
    prof: { lo, bw, half, LH, SH, LS, SS }, // raw + smoothed profiles, for drawing
    diag: { candles: N, oiMatched: matched, births: births.length, venues: venues.length },
  };
}

const LIQ_DEFAULTS = {
  stepMs: 900000,
  // leverage mix assumed for new positions (weights sum to 1); tiers above a coin's max are capped at the max
  tiers: [[5, 0.10], [10, 0.25], [20, 0.20], [25, 0.20], [50, 0.15], [100, 0.10]],
  binPct: 0.001,     // 0.1% bins
  rangePct: 0.25,    // histogram covers +/-25%
  searchPct: 0.15,   // clusters searched within +/-15%
  sigmaBins: 2.5,    // smoothing (0.25%)
  peakWin: 5,        // a peak must be the max within +/-0.5%
  sigFrac: 0.30,     // "significant" = at least 30% of the strongest peak on that side
  zoneFrac: 0.5,     // cluster zone = where the profile stays above half the peak
};


// ---------------------------------------------------------------------------
// LODESTONE widget: the 3 coins whose nearest liquidation pool is closest to price.
// Same model and defaults as the LODESTONE page: Bybit + Binance open interest,
// 10-day lookback, retail 5-100x leverage mix, cluster = peak >= 30% of the biggest.
// Widget parameter (long-press the widget > Edit Widget > Parameter): an optional
// coin list such as "BTC, ETH, SOL". Leave it empty for the full LODESTONE list.
// ---------------------------------------------------------------------------
const PAGE = 'https://alicetin1905-ux.github.io/LODESTONE/';
const DEFAULT_COINS = ['BTC', 'ETH', 'SOL', 'DOGE', 'SUI', 'ENA', 'WLD', 'DYDX', 'GALA', 'EGLD', 'NEAR', 'XLM', 'BLUR', 'SAND', 'AXS', 'ZIL', 'CHZ', 'GRAM', '1000PEPE', 'KAITO', 'XRP', 'ATOM', '1000BONK'];
const RETAIL = [[5, 0.10], [10, 0.25], [20, 0.20], [25, 0.20], [50, 0.15], [100, 0.10]];
const STEP = 900000, KEEP = 1000, DAY = 86400000;
const COL = { bg: '#0b0d14', fg: '#e4e7f0', muted: '#8b91a8', faint: '#4f566f', up: '#2fd4a3', dn: '#ff5577', warn: '#f2b84b' };
const MINUS = '−';

const fm = FileManager.local();
const CACHE = fm.joinPath(fm.documentsDirectory(), 'lodestone-widget-cache.json');
function readCache() {
  try { if (fm.fileExists(CACHE)) { const c = JSON.parse(fm.readString(CACHE)); if (c && c.v === 1 && c.coins) return c; } } catch (e) { /* start fresh */ }
  return { v: 1, coins: {}, last: null };
}
function writeCache(c) { try { fm.writeString(CACHE, JSON.stringify(c)); } catch (e) { /* not fatal */ } }

async function getJSON(url) {
  const r = new Request(url);
  r.timeoutInterval = 12;
  return await r.loadJSON();
}
async function bybit(path) {
  const j = await getJSON('https://api.bybit.com' + path);
  if (!j || j.retCode !== 0) throw new Error((j && j.retMsg) || 'Bybit did not answer');
  return j.result;
}
function decimalsFor(tick) { if (!(tick > 0)) return 4; return Math.max(0, Math.min(10, Math.ceil(-Math.log10(tick) - 1e-9))); }

function parseCoins(p) {
  const out = [];
  for (const x of String(p || '').split(/[\s,;]+/)) {
    const b = x.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
    if (b && out.indexOf(b) < 0) out.push(b);
  }
  return out.length ? out.slice(0, 40) : DEFAULT_COINS.slice();
}

// ---------- data: incremental updates on top of a cached history ----------
async function updateCoin(cache, base) {
  const sym = base + 'USDT', now = Date.now();
  let c = cache.coins[sym];
  if (!c) c = cache.coins[sym] = { candles: [], oi: [], bin: [], binScale: 0, binNone: 0, info: null };
  if (!c.info || now - c.info.at > DAY) {
    const res = await Promise.all([
      bybit('/v5/market/instruments-info?category=linear&symbol=' + sym),
      bybit('/v5/market/risk-limit?category=linear&symbol=' + sym)
    ]);
    const i = res[0].list && res[0].list[0];
    if (!i || i.status !== 'Trading') { c.bad = true; throw new Error(base + ' is not a live Bybit perp'); }
    const tiers = res[1].list || [];
    let t1 = null;
    for (const t of tiers) if (+t.isLowestRisk === 1) { t1 = t; break; }
    if (!t1 && tiers.length) t1 = tiers.reduce((a, b) => (+a.riskLimitValue <= +b.riskLimitValue ? a : b));
    const mmr = t1 ? +t1.maintenanceMargin : NaN;
    c.info = { maxLev: +i.leverageFilter.maxLeverage || 50, mmr: mmr > 0 && mmr < 0.5 ? mmr : 0.01, dec: decimalsFor(+i.priceFilter.tickSize), at: now };
  }
  // candles
  const lastT = c.candles.length ? c.candles[c.candles.length - 1][0] : 0;
  const nowStart = Math.floor(now / STEP) * STEP;
  const gap = lastT ? Math.round((nowStart - lastT) / STEP) : KEEP;
  const kl = await bybit('/v5/market/kline?category=linear&symbol=' + sym + '&interval=15&limit=' + Math.min(1000, Math.max(3, gap + 3)));
  const rows = (kl.list || []).map((r) => [+r[0], +r[1], +r[2], +r[3], +r[4], +r[5], +r[6]]).reverse();
  if (!rows.length) throw new Error('No candles for ' + base);
  if (!lastT || gap >= 990) c.candles = rows;
  else { const t0 = rows[0][0]; c.candles = c.candles.filter((x) => x[0] < t0).concat(rows); }
  if (c.candles.length > KEEP) c.candles = c.candles.slice(-KEEP);
  const first = c.candles[0][0], price = c.candles[c.candles.length - 1][4];
  // Bybit open interest
  const oi = new Map(c.oi);
  const haveOi = c.oi.length ? c.oi[c.oi.length - 1][0] : 0;
  const needFrom = haveOi && haveOi > first ? haveOi : first;
  let cursor = '';
  for (let p = 0; p < 10; p++) {
    const lim = haveOi && haveOi > first ? Math.min(200, Math.round((now - haveOi) / STEP) + 3) : 200;
    const r = await bybit('/v5/market/open-interest?category=linear&symbol=' + sym + '&intervalTime=15min&limit=' + lim + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    const list = r.list || [];
    let minT = Infinity;
    for (const x of list) { const t = +x.timestamp; oi.set(t, +x.openInterest); if (t < minT) minT = t; }
    cursor = r.nextPageCursor;
    if (!cursor || !list.length || minT <= needFrom) break;
  }
  c.oi = Array.from(oi.entries()).filter((x) => x[0] >= first - STEP).sort((a, b) => a[0] - b[0]);
  // Binance open interest (skipped for a day when Binance doesn't list the coin)
  if (!c.binNone || now - c.binNone > DAY) {
    try {
      const bin = new Map(c.bin);
      const haveBin = c.bin.length ? c.bin[c.bin.length - 1][0] : 0;
      let end = 0;
      for (let p = 0; p < 4; p++) {
        const lim = haveBin && haveBin > first ? Math.min(500, Math.round((now - haveBin) / STEP) + 3) : 500;
        const rows2 = await getJSON('https://fapi.binance.com/futures/data/openInterestHist?symbol=' + sym + '&period=15m&limit=' + lim + (end ? '&endTime=' + end : ''));
        if (!Array.isArray(rows2)) throw new Error('not on Binance');
        if (!rows2.length) break;
        let minT = Infinity;
        for (const x of rows2) {
          const o = +x.sumOpenInterest, val = +x.sumOpenInterestValue, t = +x.timestamp;
          if (!(o > 0)) continue;
          if (!c.binScale && val > 0) c.binScale = Math.pow(10, Math.round(Math.log10(price / (val / o))));
          bin.set(t, o / (c.binScale || 1));
          if (t < minT) minT = t;
        }
        if (haveBin && haveBin > first) break;
        if (minT <= first) break;
        end = minT - 1;
      }
      c.bin = Array.from(bin.entries()).filter((x) => x[0] >= first - STEP).sort((a, b) => a[0] - b[0]);
      c.binNone = 0;
    } catch (e) { c.bin = []; c.binNone = now; }
  }
  c.at = now;
}

function computeCoin(c) {
  const candles = c.candles.map((a) => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4], v: a[5], q: a[6] }));
  const venues = [new Map(c.oi)];
  if (c.bin.length) venues.push(new Map(c.bin));
  const price = candles[candles.length - 1].c;
  const r = liqMap(candles, venues, Object.assign({}, LIQ_DEFAULTS, { tiers: RETAIL, sigFrac: 0.3, mmr: c.info.mmr, maxLev: c.info.maxLev, price: price }));
  const pick = (x) => (x ? { px: x.px, size: x.size } : null);
  return { price: price, dec: c.info.dec, up: pick(r.up.nearest), dn: pick(r.down.nearest) };
}

async function refresh(cache, coins, budgetMs) {
  const deadline = Date.now() + budgetMs, errors = [];
  let i = 0;
  const worker = async () => {
    while (i < coins.length) {
      const b = coins[i++];
      if (Date.now() > deadline) { errors.push(b + ': out of time'); continue; }
      const c = cache.coins[b + 'USDT'];
      if (c && c.bad && c.info && Date.now() - c.info.at < DAY) { errors.push(b + ': not on Bybit'); continue; }
      try { await updateCoin(cache, b); } catch (e) { errors.push(b + ': ' + (e && e.message ? e.message : e)); }
    }
  };
  const jobs = [];
  for (let k = 0; k < Math.min(6, coins.length); k++) jobs.push(worker());
  await Promise.all(jobs);
  const results = [];
  for (const b of coins) {
    const c = cache.coins[b + 'USDT'];
    if (!c || !c.info || c.candles.length < 100 || c.oi.length < 50) continue;
    try { const r = computeCoin(c); r.coin = b; r.at = c.at; results.push(r); } catch (e) { errors.push(b + ': ' + e.message); }
  }
  for (const k of Object.keys(cache.coins)) if (coins.indexOf(k.replace(/USDT$/, '')) < 0) delete cache.coins[k];
  return { results: results, errors: errors, at: Date.now() };
}

function ranked(results) {
  const rows = [];
  for (const r of results) {
    let best = null;
    for (const side of ['up', 'dn']) {
      const p = r[side];
      if (!p) continue;
      const d = (p.px / r.price - 1) * 100;
      if (!best || Math.abs(d) < Math.abs(best.dist)) best = { coin: r.coin, side: side, px: p.px, size: p.size, dist: d, price: r.price, dec: r.dec };
    }
    if (best) rows.push(best);
  }
  return rows.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist));
}

// ---------- widget ----------
function fpct(x) { const a = Math.abs(x).toFixed(2); return (+a === 0 ? '' : x > 0 ? '+' : MINUS) + a + '%'; }
function fusd(x) {
  if (!(x > 0)) return '$0';
  if (x >= 1e9) return '$' + (x / 1e9).toFixed(1) + 'B';
  if (x >= 1e6) return '$' + (x / 1e6).toFixed(x >= 1e7 ? 0 : 1) + 'M';
  if (x >= 1e3) return '$' + Math.round(x / 1e3) + 'K';
  return '$' + Math.round(x);
}
function hhmm(t) { const d = new Date(t); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
function shortName(b) { return b.replace(/^1000/, ''); }

function build(family, data) {
  const w = new ListWidget();
  w.url = PAGE;
  w.refreshAfterDate = new Date(Date.now() + 10 * 60000);
  const rows = data ? ranked(data.results) : [];
  const accessory = /^accessory/.test(family || '');
  if (accessory) {
    if (family === 'accessoryInline') {
      const t = w.addText(rows.length ? rows.slice(0, 2).map((r) => shortName(r.coin) + (r.side === 'up' ? ' ▲' : ' ▼') + fpct(r.dist)).join('  ') : 'LODESTONE');
      t.font = Font.mediumMonospacedSystemFont(12);
      return w;
    }
    if (family === 'accessoryCircular') {
      const r = rows[0];
      const a = w.addText(r ? shortName(r.coin) : 'LODE'); a.font = Font.boldMonospacedSystemFont(11); a.minimumScaleFactor = 0.5; a.centerAlignText();
      const b = w.addText(r ? (r.side === 'up' ? '▲' : '▼') + Math.abs(r.dist).toFixed(1) + '%' : '—'); b.font = Font.mediumMonospacedSystemFont(11); b.minimumScaleFactor = 0.5; b.centerAlignText();
      return w;
    }
    for (const r of rows.slice(0, 3)) {
      const t = w.addText(shortName(r.coin) + (r.side === 'up' ? ' ▲ ' : ' ▼ ') + fpct(r.dist) + ' ' + r.px.toFixed(r.dec));
      t.font = Font.mediumMonospacedSystemFont(12); t.lineLimit = 1; t.minimumScaleFactor = 0.6;
    }
    if (!rows.length) { const t = w.addText('LODESTONE: run once in Scriptable'); t.font = Font.systemFont(12); }
    return w;
  }

  w.backgroundColor = new Color(COL.bg);
  const small = family === 'small';
  w.setPadding(small ? 12 : 14, small ? 12 : 16, small ? 12 : 14, small ? 12 : 16);
  const head = w.addStack();
  head.layoutHorizontally(); head.centerAlignContent();
  const title = head.addText(small ? 'LODESTONE' : 'LODESTONE · nearest pools');
  title.font = Font.boldMonospacedSystemFont(small ? 11 : 12); title.textColor = new Color(COL.fg); title.lineLimit = 1; title.minimumScaleFactor = 0.7;
  head.addSpacer();
  const tm = head.addText(data ? hhmm(data.at) : '--:--');
  tm.font = Font.mediumMonospacedSystemFont(10); tm.textColor = new Color(COL.muted);
  w.addSpacer(small ? 8 : 10);

  if (!rows.length) {
    const t = w.addText(data && data.errors.length ? 'No data: ' + data.errors[0] : 'Open Scriptable and run LODESTONE once to load the history.');
    t.font = Font.systemFont(12); t.textColor = new Color(COL.muted);
    w.addSpacer();
    return w;
  }
  const n = family === 'large' ? 10 : 3;
  rows.slice(0, n).forEach((r, idx) => {
    const s = w.addStack();
    s.layoutHorizontally(); s.centerAlignContent();
    const sideCol = new Color(r.side === 'up' ? COL.up : COL.dn);
    const name = s.addText(small ? shortName(r.coin) : r.coin);
    name.font = Font.boldMonospacedSystemFont(small ? 13 : 14); name.textColor = new Color(COL.fg); name.lineLimit = 1; name.minimumScaleFactor = 0.6;
    s.addSpacer();
    if (!small) {
      const px = s.addText(r.px.toFixed(r.dec));
      px.font = Font.regularMonospacedSystemFont(12); px.textColor = new Color(COL.muted); px.lineLimit = 1; px.minimumScaleFactor = 0.6;
      s.addSpacer(10);
      const sz = s.addText(fusd(r.size));
      sz.font = Font.regularMonospacedSystemFont(12); sz.textColor = new Color(COL.muted); sz.lineLimit = 1;
      s.addSpacer(10);
    }
    const ar = s.addText(r.side === 'up' ? '▲ ' : '▼ ');
    ar.font = Font.boldMonospacedSystemFont(small ? 10 : 11); ar.textColor = sideCol;
    const pc = s.addText(fpct(r.dist));
    pc.font = Font.boldMonospacedSystemFont(small ? 13 : 14);
    pc.textColor = Math.abs(r.dist) <= 1 ? new Color(COL.warn) : sideCol;
    pc.lineLimit = 1; pc.minimumScaleFactor = 0.6;
    if (idx < Math.min(n, rows.length) - 1) w.addSpacer(small ? 6 : family === 'large' ? 6 : 7);
  });
  w.addSpacer();
  const stale = Date.now() - data.at > 45 * 60000;
  if (stale || data.errors.length) {
    const f = w.addText(stale ? 'Last update ' + hhmm(data.at) : data.errors.length + ' coin' + (data.errors.length > 1 ? 's' : '') + ' not updated');
    f.font = Font.systemFont(9); f.textColor = new Color(stale ? COL.warn : COL.faint); f.lineLimit = 1;
  }
  return w;
}

// ---------- run ----------
const coins = parseCoins(args.widgetParameter);
const cache = readCache();
let data = null;
try {
  data = await refresh(cache, coins, config.runsInWidget ? 20000 : 120000);
  if (data.results.length) cache.last = data; else if (cache.last) data = Object.assign({}, cache.last, { errors: data.errors });
} catch (e) {
  data = cache.last ? Object.assign({}, cache.last, { errors: [String(e)] }) : null;
}
writeCache(cache);
const widget = build(config.widgetFamily || 'medium', data);
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  const rows = data ? ranked(data.results) : [];
  console.log('LODESTONE · nearest pools');
  for (const r of rows.slice(0, 10)) console.log(r.coin + ' ' + (r.side === 'up' ? '▲ ' : '▼ ') + fpct(r.dist) + '  pool ' + r.px.toFixed(r.dec) + '  ' + fusd(r.size));
  if (data && data.errors.length) console.log('Not updated: ' + data.errors.join('; '));
  await widget.presentMedium();
}
Script.complete();
