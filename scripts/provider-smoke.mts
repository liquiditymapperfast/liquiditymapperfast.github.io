import { smokeRecord, smokeArray } from './smoke-boundaries.mts';
import fs from 'node:fs';
import path from 'node:path';
interface PriceSummary {
  count: number; validPriceCount: number; minPrice: number | null; maxPrice: number | null;
  totalSize: number; firstPrice: number | null; lastPrice: number | null;
}
interface HyperliquidSmokeRequest { type: 'l2Book'; coin: string; nSigFigs?: number }
interface BinanceSmokeRequest { symbol: string; limit: number }
interface ProviderSmokeSource {
  request: HyperliquidSmokeRequest | BinanceSmokeRequest;
  status: number; ok: boolean; elapsedMs: number; bids: PriceSummary; asks: PriceSummary;
  lastUpdateId?: number | null;
}
interface ProviderSmokeEvidence {
  generatedAt: string; readOnly: true; scope: string; sources: Record<string, ProviderSmokeSource>;
}
const out = 'docs/acceptance/visual-parity/m3-feeds/provider-smoke-2026-09-12.json';
const timeoutMs = 15000;
const price = (r: unknown) => Number(Array.isArray(r) ? r[0] : smokeRecord(r).px ?? smokeRecord(r).price);
const size = (r: unknown) => Number(Array.isArray(r) ? r[1] : smokeRecord(r).sz ?? smokeRecord(r).size ?? smokeRecord(r).qty);
const sum = (rows: unknown[]): PriceSummary => {
  const prices = rows.map(price).filter(x => Number.isFinite(x) && x > 0);
  const sizes = rows.map(size).filter(x => Number.isFinite(x) && x >= 0);
  return { count: rows.length, validPriceCount: prices.length, minPrice: prices.length ? Math.min(...prices) : null, maxPrice: prices.length ? Math.max(...prices) : null, totalSize: sizes.reduce((a, x) => a + x, 0), firstPrice: prices[0] ?? null, lastPrice: prices.at(-1) ?? null };
};
async function get(url: string, init: RequestInit = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
    let body: unknown = null; try { body = JSON.parse(await r.text()); } catch {}
    return { status: r.status, ok: r.ok, elapsedMs: Date.now() - started, body };
  } finally { clearTimeout(timer); }
}
const evidence: ProviderSmokeEvidence = { generatedAt: new Date().toISOString(), readOnly: true, scope: 'public REST snapshots only; no credentials, subscriptions, or private payloads', sources: {} };
for (const resolution of ['native', 3, 2]) {
  const request: HyperliquidSmokeRequest = { type: 'l2Book', coin: 'BTC' };
  if (typeof resolution === 'number') request.nSigFigs = resolution;
  const r = await get('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  const levels = smokeArray(smokeRecord(r.body).levels);
  evidence.sources['hyperliquid:' + resolution] = { request, status: r.status, ok: r.ok, elapsedMs: r.elapsedMs, bids: sum(smokeArray(smokeArray(levels)[0])), asks: sum(smokeArray(smokeArray(levels)[1])) };
}
const request = { symbol: 'BTCUSDT', limit: 1000 };
const r = await get('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000');
evidence.sources.binance = { request, status: r.status, ok: r.ok, elapsedMs: r.elapsedMs, lastUpdateId: Number(smokeRecord(r.body).lastUpdateId ?? 0) || null, bids: sum(smokeArray(smokeRecord(r.body).bids)), asks: sum(smokeArray(smokeRecord(r.body).asks)) };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
if (Object.values(evidence.sources).some(x => !x.ok)) process.exitCode = 1;