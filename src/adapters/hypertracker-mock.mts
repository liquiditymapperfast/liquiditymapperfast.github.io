export type MockScenario = 'ready' | 'empty' | 'error';
export type HyperTrackerMode = 'disabled' | 'mock' | 'live';
export function hyperTrackerMode(mode: unknown, enabled: unknown): HyperTrackerMode {
  if (mode === undefined || mode === '') return enabled === 'true' ? 'live' : 'disabled';
  if (mode !== 'disabled' && mode !== 'mock' && mode !== 'live') throw new RangeError('HYPERTRACKER_MODE must be disabled, mock, or live');
  if (mode === 'live' && enabled !== 'true') throw new Error('Live HyperTracker requires ENABLE_HYPERTRACKER=true');
  return mode;
}
interface MockOptions { now?: () => number; referencePrice?: () => number; scenario?: MockScenario; }
interface MockLiquidationRow {
  id: string; coin: string; price: number; liquidationValue: number;
  positionsCount: number; side: 'long' | 'short';
}
interface MockOrderRow {
  oid: string; coin: string; triggerPx: number; sz: number; side: 'buy' | 'sell';
  orderType: 'Stop Market' | 'Stop Limit' | 'Take Profit Market' | 'Take Profit Limit';
  sizeUnit: 'base'; limitPx?: number;
}
export interface MockSnapshot {
  sourceKind: string; source: 'hypertracker-mock'; mock: true; generatedAt: number;
  sourceTimestamp: number; revision: string; complete: true; nextCursor: null;
  units: 'USD notional' | 'base'; levels?: MockLiquidationRow[]; orders?: MockOrderRow[];
}
/** Backend-only development provider. It has no token, transport, or quota ledger. */
export class MockHyperTrackerClient {
  readonly mock = true;
  readonly source = 'hypertracker-mock';
  #now: () => number;
  #referencePrice: () => number;
  #scenario: MockScenario;
  #timestamp = 0;
  constructor({ now = Date.now, referencePrice = () => 77_300, scenario = 'ready' }: MockOptions = {}) {
    this.#now = now; this.#referencePrice = referencePrice; this.#scenario = scenario;
    this.setScenario(scenario);
  }
  setScenario(scenario: unknown) {
    if (scenario !== 'ready' && scenario !== 'empty' && scenario !== 'error') throw new RangeError('Unknown mock HyperTracker scenario');
    this.#scenario = scenario;
  }
  async request(kind: string, { coin = 'BTC' }: { coin?: string; path?: unknown; automatic?: boolean } = {}): Promise<MockSnapshot> {
    if (!['liquidation', 'stopLoss', 'takeProfit', 'orders'].includes(kind)) throw new RangeError('Unsupported mock HyperTracker request');
    if (typeof coin !== 'string' || !/^[A-Z0-9]{1,16}$/.test(coin)) throw new RangeError('Invalid mock provider coin');
    if (this.#scenario === 'error') throw new Error('Mock HyperTracker refresh failure');
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Mock provider clock unavailable');
    const sourceTimestamp = Math.max(now, this.#timestamp + 1);
    if (!Number.isSafeInteger(sourceTimestamp)) throw new Error('Mock provider revision clock exhausted');
    const levels: MockLiquidationRow[] = [];
    const orders: MockOrderRow[] = [];
    if (this.#scenario !== 'empty') {
      const mark = this.#referencePrice();
      if (!Number.isFinite(mark) || mark <= 0) throw new Error('Mock provider reference price unavailable');
      const layers = kind === 'orders' ? ['stopLoss', 'takeProfit'] : [kind];
      for (const layer of layers) for (const direction of [-1, 1]) for (let index = 0; index < 48; index++) {
        const distance = .0025 + index * .0016;
        // Significant-digit rounding also supports small-price development coins.
        const price = Number((mark * (1 + direction * distance)).toPrecision(12));
        const wall = index % 11 === 0 ? 9 : index % 5 === 0 ? 3 : 1;
        const notional = (70_000 + (index % 7) * 17_000) * wall;
        if (!Number.isFinite(price) || price <= 0) throw new Error('Mock provider reference price cannot produce finite levels');
        const id = 'mock-' + layer + '-' + coin + '-' + direction + '-' + index;
        if (layer === 'liquidation') {
          levels.push({ id, coin, price, liquidationValue: notional, positionsCount: 2 + index % 9, side: direction < 0 ? 'long' : 'short' });
        } else {
          const side = direction < 0 ? (layer === 'stopLoss' ? 'sell' : 'buy') : (layer === 'stopLoss' ? 'buy' : 'sell');
          const sz = notional / price;
          if (!Number.isFinite(sz) || sz <= 0) throw new Error('Mock provider reference price cannot produce finite order sizes');
          const market = index % 2 === 0;
          const orderType = layer === 'stopLoss' ? (market ? 'Stop Market' : 'Stop Limit') : (market ? 'Take Profit Market' : 'Take Profit Limit');
          // Limit execution price deliberately differs from the trigger: the
          // layer must plot triggerPx, and USD notional remains sz * triggerPx.
          const limitPx = Number((price * (side === 'buy' ? 1.0005 : .9995)).toPrecision(12));
          if (!market && (!Number.isFinite(limitPx) || limitPx <= 0)) throw new Error('Mock provider reference price cannot produce finite limit prices');
          orders.push({ oid: id, coin, triggerPx: price, sz, side, orderType, sizeUnit: 'base', ...(!market ? { limitPx } : {}) });
        }
      }
    }
    // Failed generation never advances the last successful revision.
    this.#timestamp = sourceTimestamp;
    return { sourceKind: kind, source: this.source, mock: true, generatedAt: now, sourceTimestamp, revision: String(sourceTimestamp), complete: true, nextCursor: null,
      units: kind === 'liquidation' ? 'USD notional' : 'base', ...(kind === 'liquidation' ? { levels } : { orders }) };
  }
}
