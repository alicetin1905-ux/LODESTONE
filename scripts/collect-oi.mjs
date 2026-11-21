// Collects open interest from OKX and MEXC for the LODESTONE coin list.
// Browsers can't read these themselves (no CORS on OKX's open-interest history, none at all on MEXC),
// so a scheduled GitHub Action runs this and publishes data/oi.json on the `data` branch,
// which the page and the widget read from raw.githubusercontent.com.
//
// usage: node scripts/collect-oi.mjs <index.html> <data dir>
//  - OKX: 15-minute open-interest history (backfilled to ~11 days, then the newest page each run)
//  - MEXC: has no history API, so every run stores a snapshot in mexc-raw.json; the published series
//    is those snapshots interpolated onto the 15-minute boundaries
// Values are in each exchange's own coin units with `px` (that exchange's price per unit); the page
// rescales to Bybit's units (e.g. 1000PEPE) from the price ratio, as it already does for Binance.
import fs from 'node:fs';
import path from 'node:path';

const STEP = 900000, KEEP = 1100, DAY = 86400000;
const [htmlPath, dir] = process.argv.slice(2);
const html = fs.readFileSync(htmlPath, 'utf8');
const m = html.match(/const DEFAULT_COINS = \[([^\]]+)\]/);
if (!m) throw new Error('DEFAULT_COINS not found');
const COINS = m[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return d; } };
const sig = (x) => (x == null || !isFinite(x) ? null : +x.toPrecision(7));
const now = Date.now(), lastB = Math.floor(now / STEP) * STEP;
const candidates = (b) => (/^1000+/.test(b) ? [b, b.replace(/^1000+/, '')] : [b]);

async function getJSON(url, tries = 4) {
  let err;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'lodestone-collector' } });
      if (r.status === 429) { await sleep(2000 * (a + 1)); continue; }
      return await r.json();
    } catch (e) { err = e; await sleep(1000 * (a + 1)); }
  }
  throw err || new Error('rate limited: ' + url);
}

// series helpers: { t0, v: [...] } on the 15-minute grid, last KEEP points
function toMap(s) { const out = new Map(); if (s) s.v.forEach((v, i) => { if (v != null) out.set(s.t0 + i * STEP, v); }); return out; }
function fromMap(mp) {
  const ts = [...mp.keys()].filter((t) => t > lastB - KEEP * STEP).sort((a, b) => a - b);
  if (!ts.length) return null;
  const t0 = ts[0], v = new Array(Math.round((ts[ts.length - 1] - t0) / STEP) + 1).fill(null);
  for (const t of ts) v[Math.round((t - t0) / STEP)] = sig(mp.get(t));
  return { t0, v };
}

const prev = readJSON('oi.json', { okx: {}, mexc: {} });
const out = { v: 1, at: now, step: STEP, coins: COINS, okx: {}, mexc: {}, errors: [] };

// ---------- OKX ----------
const okxIds = new Set((await getJSON('https://www.okx.com/api/v5/public/instruments?instType=SWAP')).data.map((x) => x.instId));
for (const base of COINS) {
  const inst = candidates(base).map((b) => b + '-USDT-SWAP').find((i) => okxIds.has(i));
  if (!inst) continue;
  try {
    const old = prev.okx[base] && prev.okx[base].inst === inst ? prev.okx[base] : null;
    const mp = toMap(old);
    const haveTo = mp.size ? Math.max(...mp.keys()) : 0;
    let end = '';
    for (let p = 0; p < 12; p++) {
      const j = await getJSON('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=' + inst + '&period=15m&limit=100' + (end ? '&end=' + end : ''));
      if (j.code !== '0') throw new Error(j.msg || 'OKX ' + j.code);
      const rows = j.data || [];
      if (!rows.length) break;
      for (const r of rows) mp.set(+r[0], +r[2]);          // [ts, contracts, coins, usd]
      const minT = Math.min(...rows.map((r) => +r[0]));
      await sleep(450);                                       // rubik endpoints: 5 requests per 2 s
      if (minT <= haveTo || minT <= lastB - KEEP * STEP) break;
      end = String(minT - 1);
    }
    const tk = await getJSON('https://www.okx.com/api/v5/market/ticker?instId=' + inst);
    const s = fromMap(mp);
    if (s) out.okx[base] = Object.assign({ inst, px: sig(+tk.data[0].last) }, s);
    await sleep(150);
  } catch (e) {
    out.errors.push('OKX ' + base + ': ' + e.message);
    if (prev.okx[base]) out.okx[base] = prev.okx[base];
  }
}

// ---------- MEXC ----------
const raw = readJSON('mexc-raw.json', {});
try {
  const [tick, det] = await Promise.all([
    getJSON('https://contract.mexc.com/api/v1/contract/ticker'),
    getJSON('https://contract.mexc.com/api/v1/contract/detail')
  ]);
  const T = new Map(tick.data.map((x) => [x.symbol, x])), D = new Map(det.data.map((x) => [x.symbol, x]));
  for (const base of COINS) {
    const sym = candidates(base).map((b) => b + '_USDT').find((s) => T.has(s) && D.has(s));
    if (!sym) continue;
    const t = T.get(sym), size = +D.get(sym).contractSize;
    const coins = +t.holdVol * size;
    if (!(coins > 0)) continue;
    const r = raw[base] && raw[base].sym === sym ? raw[base] : { sym, s: [] };
    r.px = sig(+t.lastPrice);
    r.s.push([now, sig(coins)]);
    r.s = r.s.filter((x) => x[0] > now - 12 * DAY);
    raw[base] = r;
  }
} catch (e) { out.errors.push('MEXC: ' + e.message); }
for (const [base, r] of Object.entries(raw)) {
  if (!COINS.includes(base)) { delete raw[base]; continue; }
  // a boundary gets a value when snapshots bracket it within 20 minutes (linear interpolation),
  // or when one snapshot is within 4 minutes of it
  const s = r.s, mp = new Map();
  let k = 0;
  for (let b = Math.ceil(s[0][0] / STEP) * STEP - STEP; b <= lastB; b += STEP) {
    while (k + 1 < s.length && s[k + 1][0] <= b) k++;
    const lo = s[k][0] <= b ? s[k] : null, hi = s.find((x) => x[0] >= b);
    let v = null;
    if (lo && hi && hi[0] - lo[0] <= 20 * 60000) v = hi[0] === lo[0] ? lo[1] : lo[1] + (hi[1] - lo[1]) * (b - lo[0]) / (hi[0] - lo[0]);
    else if (lo && b - lo[0] <= 4 * 60000) v = lo[1];
    else if (hi && hi[0] - b <= 4 * 60000) v = hi[1];
    if (v != null) mp.set(b, v);
  }
  const ser = fromMap(mp);
  if (ser) out.mexc[base] = Object.assign({ sym: r.sym, px: r.px, since: s[0][0] }, ser);
}

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'oi.json'), JSON.stringify(out));
fs.writeFileSync(path.join(dir, 'mexc-raw.json'), JSON.stringify(raw));
const n = (o) => Object.keys(o).length;
console.log(`OKX ${n(out.okx)} coins, MEXC ${n(out.mexc)} coins, ${out.errors.length} errors${out.errors.length ? ': ' + out.errors.join('; ') : ''}`);
