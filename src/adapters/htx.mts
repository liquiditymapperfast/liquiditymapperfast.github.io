import { recordValue, type AdapterOptions, type AdapterTransport, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol, sideLevels } from './common.mts';

/** HTX (Huobi) USDT-margined swap depth descriptors and pure normalizers. */
export const HTX_USDT_REST_URL = 'https://api.hbdm.com';
export const HTX_USDT_WS_URL = 'wss://api.hbdm.com/linear-swap-ws';

function contract(value: unknown) {
  const native = requireSymbol(value).replaceAll('_', '-').replaceAll('/', '-');
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(native)) throw new TypeError('Invalid HTX contract symbol');
  return native;
}

function instrumentId(value: unknown) { return `htx:${contract(value)}`; }

function marketFor(value: unknown, metadata: WireRecord = {}) {
  const nativeSymbol = contract(value);
  const [base, quote = 'USDT'] = nativeSymbol.split('-');
  return {
    venue: 'htx', nativeSymbol, symbol: nativeSymbol,
    base: String(metadata.base ?? base).toUpperCase(),
    quote: String(metadata.quote ?? quote).toUpperCase(),
    marketType: 'perpetual', tickSize: metadata.tickSize ?? null,
    quantityUnit: 'contract',
  };
}

function assertHtx(payload: unknown) {
  const status = recordValue(payload)?.status == null ? null : String(recordValue(payload).status).toLowerCase();
  if (status != null && status !== 'ok') throw new Error(`HTX provider error ${recordValue(payload)?.['err-code'] ?? recordValue(payload)?.errCode ?? status}: ${recordValue(payload)?.['err-msg'] ?? recordValue(payload)?.errMsg ?? 'request failed'}`);
  return payload;
}

function sequence(value: unknown, field: string) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`HTX ${field} is unsafe numeric; preserve the provider token as a string`);
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`HTX ${field} missing or invalid`);
  const integer = BigInt(text);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}

export function buildHtxRequest(kind: string, { symbol = 'BTC-USDT', type = 'step6', baseUrl = HTX_USDT_REST_URL }: AdapterOptions = {}) {
  const native = contract(symbol);
  if (kind === 'contracts') return { url: `${baseUrl}/linear-swap-api/v1/swap_contract_info?contract_code=${encodeURIComponent(native)}`, method: 'GET', headers: { accept: 'application/json' } };
  if (kind === 'depth') {
    if (!/^step(?:0|[1-9]|1[0-9])$/.test(String(type))) throw new RangeError(`Unsupported HTX depth type: ${type}`);
    return { url: `${baseUrl}/linear-swap-ex/market/depth?contract_code=${encodeURIComponent(native)}&type=${encodeURIComponent(type)}`, method: 'GET', headers: { accept: 'application/json' } };
  }
  throw new RangeError(`Unsupported HTX request: ${kind}`);
}

export function buildHtxSubscription(kind: string, { symbol = 'BTC-USDT', type = 'step6', id = '1' }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported HTX subscription: ${kind}`);
  const native = contract(symbol);
  if (!/^step(?:0|[1-9]|1[0-9])$/.test(String(type))) throw new RangeError(`Unsupported HTX depth type: ${type}`);
  const topic = `market.${native}.depth.${type}`;
  return { url: HTX_USDT_WS_URL, sub: topic, id: String(id), channel: topic, topic, symbol: native, type: String(type), args: [topic], snapshot: true };
}

export function normalizeHtxContractInfo(payload: unknown, { receivedAt = Date.now() }: AdapterOptions = {}) {
  const rows = recordValue(assertHtx(payload))?.data;
  if (!Array.isArray(rows)) throw new TypeError('HTX contract metadata must be an array');
  const assets = rows.map((row: unknown) => {
    const native = recordValue(row)?.contract_code;
    if (!native || String(recordValue(row)?.contract_type ?? '').toLowerCase() !== 'swap' || String(recordValue(row)?.business_type ?? '').toLowerCase() !== 'swap') return null;
    const normalized = contract(native);
    const [base, quote = 'USDT'] = normalized.split('-');
    const contractValue = finiteNumber(recordValue(row).contract_size, 'contract_size');
    const tickSize = finiteNumber(recordValue(row).price_tick, 'price_tick');
    if (!(contractValue > 0) || !(tickSize > 0)) throw new TypeError('HTX contract size and price tick must be positive');
    const state = Number(recordValue(row).contract_status);
    const enabled = state === 1;
    return {
      instrumentId: instrumentId(normalized), venue: 'htx', nativeSymbol: normalized, symbol: normalized,
      base: String(recordValue(row).symbol ?? base).toUpperCase(), quote: String(recordValue(row).pair ?? `${base}-${quote}`).split('-').at(-1)!.toUpperCase(),
      marketType: 'perpetual', tickSize, quantityUnit: 'contract', contractValue,
      isDelisted: !enabled, status: enabled ? 'online' : 'offline', lotSize: 1,
      metadataSource: 'htx-swap-contract-info',
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return { kind: 'metadata' as const, venue: 'htx', sourceTimestamp: epochMs(recordValue(payload)?.ts, receivedAt), receivedAt, assets };
}

export function normalizeHtxDepth(payload: unknown, { symbol = 'BTC-USDT', type = 'step6', receivedAt = Date.now(), contractValue = null }: AdapterOptions = {}) {
  const envelope = assertHtx(payload);
  const native = contract(symbol);
  const expectedTopic = `market.${native}.depth.${type}`;
  if (String(recordValue(envelope)?.ch ?? '').toUpperCase() !== expectedTopic.toUpperCase()) throw new TypeError('HTX depth channel mismatch');
  const tick = recordValue(envelope)?.tick;
  if (!tick || !Array.isArray(recordValue(tick).bids) || !Array.isArray(recordValue(tick).asks)) throw new TypeError('HTX depth bids/asks missing');
  if (recordValue(tick).ch != null && String(recordValue(tick).ch).toUpperCase() !== expectedTopic.toUpperCase()) throw new TypeError('HTX depth tick channel mismatch');
  const version = sequence(recordValue(tick).version, 'depth version');
  const market = marketFor(native, { base: native.split('-')[0], quote: native.split('-')[1] });
  return {
    kind: 'depthSnapshot' as const, venue: 'htx', instrumentId: instrumentId(native), nativeSymbol: native, market, units: 'contract',
    ...(contractValue != null ? { contractValue: finiteNumber(contractValue, 'contractValue') } : {}),
    sourceTimestamp: epochMs(recordValue(tick).ts ?? recordValue(envelope).ts, receivedAt), receivedAt, sequence: version,
    continuity: 'provider-snapshot', complete: true, coverage: 'partial' as const,
    bids: sideLevels(recordValue(tick).bids, 'bids'), asks: sideLevels(recordValue(tick).asks, 'asks'),
  };
}

export class HtxConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('HTX network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildHtxRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('HTX network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildHtxSubscription(kind, params)); }
}
