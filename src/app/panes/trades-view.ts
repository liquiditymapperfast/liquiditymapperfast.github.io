import { el } from '../dom.ts';
import { t, tn } from '../i18n.ts';
import { clock, clockSeconds, usd as fmtUsd } from '../format.ts';
import { instrumentShown, mapVenues } from '../cvd/ids.ts';
import { setText } from './lower-panes.ts';
import { scaledUsd, unscaledUsd } from '../coin.ts';
import { SIZE_MAX_USD } from '../sizes.ts';
import { numberRow, selectRow, sizeRow, switchRow, togglePanel, type Panel } from '../ui.ts';
import { isPhone } from '../device.ts';
import { openSheet } from '../sheet.ts';
import { markOf } from '../venue-marks.ts';
import { venueLabel } from '../venues.ts';
import { PALETTES, type Palette } from '../theme.ts';
import { STRIDE, BOUNDARY, type TapeRing } from '../tape/ring.ts';
import { SecondTally, tallySeconds, FILL_STEP } from '../trades/tally.ts';
import { OrderScan, coincidences, copyBlock, emptyBlock, fullScale, olderFor, type Block, type FlowLike, type OlderPrints, type PrintLike, type RecordedPrints } from '../trades/blocks.ts';
import { TRADES_MINIMUMS, TRADE_UNITS, UNIT_MAX_S, readUnit, type TradesSettings } from '../trades/settings.ts';
import { SEAM_SLACK_MS, TNS_FLOOR_USD, TnsBook } from '../tns/model.ts';
import { recordedDue, recordedSeam } from '../trades/asks.ts';
import { BlockList, LIST_W, wideEnough } from './trades-blocks.ts';
import { OrderList } from './trades-orders.ts';
import { inspectorModel, renderInspector } from './trades-inspector.ts';
import type { Print } from '../prints.ts';
import type { Store } from '../store.ts';

/** The venues' order in a block's bar (the most traded first), then any other by when it is met: a venue keeps its place from block to block. */
const VENUE_ORDER = ['binance', 'bybit', 'okx', 'hyperliquid', 'bitget', 'coinbase', 'deribit', 'kraken', 'bitstamp', 'gateio', 'mexc', 'kucoin', 'htx', 'bitfinex', 'bitmex', 'cryptocom', 'dydx', 'aster'];
/** The reference market for a block's price change, in this order of preference (the most traded first; Binance's perpetual for BTC). */
const REF_ORDER = ['binance', 'bybit', 'okx', 'hyperliquid', 'bitget', 'binancespot', 'coinbase', 'bybitspot', 'okxspot', 'bitgetspot', 'deribit'];
/** How far back the per-second flow is asked for (any size before the tape): what the page reads for the Flow lines anyway. */
const FLOW_REACH_MS = 24 * 3_600_000;
/** Orders read at most for one inspected block's notes and largest orders (a long block on a busy coin is cut at its newest). */
const NOTE_ORDERS_MAX = 400_000;
/** The inspector's pass over a block's orders: a slice of idle time, and how many orders between two looks at the clock. */
const SLICE_MS = 4, SLICE_ORDERS = 2048;
/** A block's inspector being worked out (`TradesView.#plan`). */
interface Plan { block: Block; state: 'held' | 'newest'; unit: number; t0: number; t1: number; floor: number; big: number; scan: OrderScan; epoch: number; steps: Generator<void, void, void> }
/** Older stretches of the recording kept for the blocks on screen, and the least margin asked either side of what is on screen. */
const OLDER_KEPT = 8, OLDER_MARGIN_MS = 5 * 60_000;
/** How far the tape's start may move past what the recording's holes and its orders were asked up to before they are asked again. */
const HOLES_AGAIN_MS = 10 * 60_000;

/** A unit as the menu says it. */
export function unitLabel(unit: number): string {
  if (unit === 0) return t('Each order');
  if (unit === 1) return t('1 second');
  if (unit % 60 === 0) return tn(unit / 60, '{n} minute', '{n} minutes');
  return tn(unit, '{n} second', '{n} seconds');
}

/**
 * Trades, the flow column's second view (2026-11-13: it replaced Time & sales and All trades, which Karl could not tell apart; the design
 * is the tape study of Research_Findings.md, from two rounds with the advisor, Sol 6.1 and Astra). A row is a block of whole
 * seconds (one by default) or, as "Each order", one market order. The shell holds the two menus (Group by, Smallest order), the status
 * (the bar scale, a hold, since when), the per-second tally the blocks read, the sources before the tape (the page's per-second flow, the
 * recording's large orders: nothing is fetched that the page would not read anyway) and the inspector (beside a list wide enough, else a
 * bottom sheet on a phone).
 */
export class TradesView {
  readonly root = el('div', { class: 'trades', hidden: true });
  #bar = el('div', { class: 'trades-bar' });
  #unit = el('select', { class: 'trades-unit', ariaLabel: t('Group by') });
  #floor = el('select', { class: 'trades-floor', ariaLabel: t('Smallest order') });
  #status = el('span', { class: 'trades-status' });
  #body = el('div', { class: 'trades-body' });
  #inspector = el('div', { class: 'trades-inspector', hidden: true, role: 'region', ariaLabel: t('Block details') });
  readonly blocks = new BlockList();
  readonly orders: OrderList;
  #tally = new SecondTally(tallySeconds(isPhone()));
  #shown = false;
  #palette: Palette = PALETTES.light!;
  #panel: Panel | null = null;
  #filterKey = '';
  #fillTimer = 0; #tick = 0;
  #recorded: RecordedPrints | null = null;
  #recordedState: 'no' | 'asking' | 'done' = 'no'; #recordedMin = Infinity;
  #older: OlderPrints[] = [];
  #olderAsking = false; #olderRetryAt = 0;
  #holesState: 'no' | 'asking' | 'done' = 'no'; #holesRetryAt = 0; #holesTo = 0; #holesKey = '';
  /** What the holes were asked under (the flow's loads, the markets) and when: either changing asks again, at most once a minute. */
  #holesLoads = -1; #holesMarkets = ''; #holesAskedAt = 0;
  #recordedRetryAt = 0; #recordedAt = 0;
  /** Each market's coverage start in the recording (ms), from the last answer about its holes. */
  #sinceOf = new Map<string, number>();
  /** The stretch the block list last drew (seconds), asked of the recording again when an answer comes or a retry is due. */
  #olderWant: [number, number] | null = null;
  #venueIds: string[] = [];
  #scratch = emptyBlock(0);
  /** What the inspector drew last (its key), and the one pass that reads a block's orders for it. */
  #inspected = '';
  /** The scans the inspector's pass (in slices) and a tap's sheet (at once) add orders into: one each, so neither adds into the other's. */
  #scan = new OrderScan(id => markOf(id).family); #sheetScan = new OrderScan(id => markOf(id).family);
  #groupOf = new Map<string, number>(); #ringGroups: number[] = []; #ringGroupsFor: TapeRing | null = null;
  /** The tape ring (set by the page: it exists once a view has asked for the tape). */
  ring: () => TapeRing | null = () => null;
  /** Take the map to a moment or a stretch (set by the page). */
  onGoTo: (t0: number, t1: number, p0: number, p1: number) => void = () => {};
  /** A market's per-second flow the page holds (set by the page: the hub's flow book). */
  flowOf: (id: string) => FlowLike | undefined = () => undefined;
  /** Ask the page to hold flow for these markets from `from` (ms): a local read the Flow lines make anyway. */
  ensureFlow: (ids: readonly string[], from: number) => void = () => {};
  /** The recording's orders from `minUsd` up to `until` (set by the page: the hub's recent prints, the source's own recording, never an exchange). */
  recorded: ((until: number, minUsd: number) => Promise<{ prints: Print[]; from: number; holes: [number, number][]; minHole: number } | null>) | null = null;
  /** The recording's largest orders in [from, to) from `minUsd`, and the size from which it holds every order (set by the page: the hub's). */
  printsIn: ((from: number, to: number, minUsd: number) => Promise<{ prints: Print[]; floor: number }>) | null = null;
  /** The stretches of [from, to) the recording listened to none of `ids` (set by the page: the hub's, from the source's coverage record). */
  holes: ((ids: readonly string[], from: number, to: number) => Promise<{ since: number; holes: [number, number][]; sinceOf: Record<string, number> } | null>) | null = null;
  /** From when the page's per-second flow holds a market's history (set by the page: the flow book's). */
  flowHeldFrom: (id: string) => number = () => Infinity;
  /** How many times the page's per-second flow was loaded (set by the page: the flow book's loads): the blocks before the tape read it. */
  flowLoads: () => number = () => 0;

  constructor(private store: Store) {
    this.orders = new OrderList(store);
    this.#bar.append(this.#unit, this.#floor, this.#status);
    this.#body.append(this.blocks.root, this.orders.root, this.#inspector);
    this.root.append(this.#bar, this.#body);
    // A mouse over the list or the details beside it holds the blocks; leaving both lets them go (a finger's hold is the sheet's or the key's).
    this.#body.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') this.blocks.pointerWithin(true); });
    this.#body.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') this.blocks.pointerWithin(false); });
    this.#unit.onchange = () => {
      const v = this.#unit.value;
      if (v === 'custom') { this.#syncMenus(); this.openSettings(this.#unit); return; }
      const unit = readUnit(Number(v), this.store.state.trades.unit);
      if (unit !== this.store.state.trades.unit) this.#set({ unit });
    };
    this.#floor.onchange = () => { const v = Number(this.#floor.value); if (Number.isFinite(v) && v >= 0) this.#set({ minUsd: v === 0 ? 0 : unscaledUsd(v) }); };
    this.orders.ring = () => this.ring();
    this.orders.onGoTo = (at, price) => this.onGoTo(at, at, price, price);
    this.orders.onSince = () => this.#syncStatus();
    this.blocks.onGoTo = (t0, t1, p0, p1) => this.onGoTo(t0, t1, p0, p1);
    this.blocks.onHold = () => this.#syncStatus();
    this.blocks.onInspect = () => this.#inspect();
    this.blocks.onTap = s => { if (isPhone()) this.#sheet(s); };
    this.blocks.onHover = b => this.#hover(b);
    this.blocks.onDrawn = (s0, s1) => this.#askOlder(s0, s1);
    this.blocks.now = () => this.#now();
    this.blocks.endNote = at => this.#endNote(at);
    this.blocks.reader.tally = this.#tally;
    this.blocks.reader.flowOf = id => this.flowOf(id);
    this.blocks.reader.knownFrom = id => Math.max(this.#sinceOf.get(id) ?? Infinity, this.flowHeldFrom(id));
    this.blocks.reader.flowVersion = () => this.flowLoads();
    new ResizeObserver(() => this.#layout()).observe(this.root);
    this.#syncMenus();
  }

  dispose(): void { window.clearTimeout(this.#jobTimer); window.clearTimeout(this.#fillTimer); window.clearInterval(this.#tick); this.orders.dispose(); }
  #unitNow(): number { return this.store.state.trades.unit; }
  #set(change: Partial<TradesSettings>): void { this.store.set({ trades: { ...this.store.state.trades, ...change } }); }

  setShown(shown: boolean): void {
    if (shown === this.#shown) return;
    this.#shown = shown; this.root.hidden = !shown;
    window.clearInterval(this.#tick); this.#tick = 0;
    if (!shown) { this.#panel?.close(); this.blocks.setShown(false); this.orders.setShown(false); window.clearTimeout(this.#fillTimer); this.#dropJob(); return; }
    // The held block's figures can still change (a late order): its inspector is read again once a second while the view shows. The markets
    // come in after the view opens (the source's list, a venue's first book): they and the per-second history they need are checked too.
    this.#tick = window.setInterval(() => {
      if (document.hidden) return;
      // Each order too: its recorded hour waits for the ring's first order, and follows the ring's start as it wraps.
      this.#askRecorded();
      if (this.#unitNow() === 0) return;
      this.#syncMarkets(); if (this.#olderWant) this.#askOlder(this.#olderWant[0], this.#olderWant[1]);
      this.#inspect(); this.#syncStatus();
    }, 1000);
    this.refresh();
  }
  setPalette(p: Palette): void { this.#palette = p; this.blocks.setPalette(p); this.orders.setPalette(p); }
  get palette(): Palette { return this.#palette; }
  invalidate(): void { this.blocks.invalidate(); this.orders.invalidate(); }
  /** The settings, the venues or the sizes changed: the unit's list is set up again, the tally started over when what it counts changed. */
  refresh(): void {
    // Everything a redraw does as well: one store change can carry the clock, the whale size or a replay with a setting, and `main.ts`
    // calls only this one then (the rows would keep the old zone's times, the old whale's sizes).
    this.blocks.whale = this.#whale(); this.orders.redraw(); this.blocks.redrawAll(); this.#inspected = '';
    this.#syncMenus();
    const unit = this.#unitNow(), blocksOn = unit > 0;
    this.blocks.root.hidden = !blocksOn; this.orders.root.hidden = blocksOn;
    this.blocks.setShown(this.#shown && blocksOn); this.orders.setShown(this.#shown && !blocksOn);
    if (!this.#shown) return;
    // The tally does not depend on the unit: it starts over only when what it counts changed (`#syncSources` checks).
    if (blocksOn) { this.blocks.unit = unit; this.blocks.release(false); this.#syncSources(false); }
    else { this.orders.refresh(); this.#syncHistory(); }
    this.#askRecorded();
    this.#layout(); this.#syncStatus(); this.invalidate();
  }
  /** Something the rows are drawn with changed (the whale size, the time zone, a replay): drawn again as they stand. */
  redraw(): void { this.#syncMenus(); this.blocks.whale = this.#whale(); this.orders.redraw(); this.blocks.redrawAll(); this.#inspected = ''; this.#inspect(); }

  /** A batch reached the ring: the tally takes it (the blocks), or the order list does. */
  tapeArrived(): void {
    if (!this.#shown) return;
    if (this.#unitNow() === 0) { this.orders.tapeArrived(); return; }
    const ring = this.ring();
    if (!ring) return;
    if (this.#tally.ring !== ring || this.#filterKeyNow() !== this.#filterKey) { this.#syncSources(true); return; }
    this.#tally.update();
    this.#syncLate();
    this.blocks.reader.gaps = this.#gaps(ring);
    if (this.blocks.held) this.#syncStatus();
    this.blocks.invalidate();
  }

  /** What the last frame drew, for the checks that look at the view without reading its pixels. */
  get snapshot(): { unit: number; blocks: BlockList['snapshot']; orders: OrderList['snapshot']; inspector: boolean } {
    return { unit: this.#unitNow(), blocks: this.blocks.snapshot, orders: this.orders.snapshot, inspector: !this.#inspector.hidden };
  }

  // ---- the menus and the settings panel -------------------------------------------------------------------------------------------

  #syncMenus(): void {
    const s = this.store.state.trades, units = [...TRADE_UNITS];
    if (!units.includes(s.unit)) units.push(s.unit);
    units.sort((a, b) => a - b);
    const ukey = `${units.join(',')}|${document.documentElement.lang}`;
    if (this.#unit.dataset.units !== ukey) {
      this.#unit.dataset.units = ukey;
      this.#unit.replaceChildren(...units.map(u => new Option(unitLabel(u), String(u))), new Option(t('Custom…'), 'custom'));
    }
    this.#unit.value = String(s.unit);
    const chosen = s.minUsd === 0 ? 0 : scaledUsd(s.minUsd), sizes = [0, ...TRADES_MINIMUMS.map(scaledUsd)];
    if (!sizes.some(v => Math.abs(v - chosen) <= 1e-6 * Math.max(1, chosen))) sizes.push(chosen);
    sizes.sort((a, b) => a - b);
    const key = `${sizes.join(',')}|${document.documentElement.lang}`;
    if (this.#floor.dataset.sizes !== key) {
      this.#floor.dataset.sizes = key;
      this.#floor.replaceChildren(...sizes.map(v => new Option(v === 0 ? t('Any size') : `≥ $${fmtUsd(v)}`, String(v))));
    }
    this.#floor.value = String(sizes.find(v => Math.abs(v - chosen) <= 1e-6 * Math.max(1, chosen)) ?? chosen);
  }

  /** The settings panel (the column's settings key opens it in this view, and Custom… in the Group by menu). */
  openSettings(anchor: HTMLElement): void {
    this.#panel = togglePanel(anchor, { title: t('Trades'), width: 360, align: 'left', onClose: () => { this.#panel = null; } }, (_tools, body) => this.#build(body));
  }
  #build(body: HTMLElement): void {
    const s = this.store.state.trades, scaled = (v: number): number => v === 0 ? 0 : scaledUsd(v);
    body.append(
      selectRow(t('Group by'), t('One row per order, or a block of time per row: its dollars bought and sold, the markets they came from and its largest orders. A block of time can be read live; each order can only be read held.'),
        [...TRADE_UNITS.map(u => [String(u), unitLabel(u)] as [string, string]), ...(TRADE_UNITS.includes(s.unit) ? [] : [[String(s.unit), unitLabel(s.unit)] as [string, string]])], String(s.unit), v => this.#set({ unit: readUnit(Number(v), s.unit) })),
      numberRow(t('Custom length (seconds)'), t('A block of this many seconds, from 1 to 900 (15 minutes).'), { min: 1, step: 1, max: UNIT_MAX_S, value: s.unit || 1 },
        v => { const unit = readUnit(Math.round(v), s.unit); if (unit > 0) this.#set({ unit }); }),
      sizeRow(t('Smallest order'), t('Orders under this are left out, before they are added up into blocks. Any size counts every market order; time before this page listened is counted from the page\'s per-second record at any size, and from the recording from $25,000.'),
        { sign: '≥', value: scaled(s.minUsd), presets: TRADES_MINIMUMS.map(scaledUsd), min: scaledUsd(TRADES_MINIMUMS[0]!), max: scaledUsd(SIZE_MAX_USD), none: t('Any size') },
        v => this.#set({ minUsd: v === 0 ? 0 : unscaledUsd(v) })),
      selectRow(t('Side'), t('Both sides, or only the market buys or only the market sells.'), [['both', t('Both')], ['buy', t('Buys only')], ['sell', t('Sells only')]], s.side, v => this.#set({ side: v === 'buy' || v === 'sell' ? v : 'both' })),
      switchRow(t('Group bursts'), t('Each order only: orders of one market and side in the same tenth of a second are one row, their sizes added up and their price weighted by size; ×5 says how many orders.'), s.group, group => this.#set({ group })),
    );
  }

  // ---- the sources ------------------------------------------------------------------------------------------------------------------

  #whale(): number { return scaledUsd(this.store.state.sounds.tiers.find(x => x.id === 'whale')?.usd ?? 400_000); }
  /** The newest exchange time the tally read (the clock while there is none). */
  #now(): number { const n = this.#tally.newestT; return Number.isFinite(n) && n > 0 ? Math.max(n, Date.now() - 5_000) : Date.now(); }
  /** What the tally counts, as a key: the size, the side, the venues the map shows. */
  #filterKeyNow(): string {
    const s = this.store.state, venues = mapVenues(s);
    return `${s.trades.minUsd}|${s.trades.side}|${venues ? [...venues].sort().join(',') : '*'}|${[...s.disabledVenues].sort().join(',')}`;
  }
  /** The markets counted: every market the page knows or the tape met, whose venue the map shows (the lists' rule, whatever the Spot / Perp filter). */
  #markets(ring: TapeRing | null): string[] {
    const shown = instrumentShown(this.store.state), ids = new Set<string>();
    for (const m of this.store.state.markets) { const id = m.instrumentId ?? m.id; if (id) ids.add(id); }
    if (ring) for (const id of ring.ids) ids.add(id);
    return [...ids].filter(shown);
  }
  /** Tally, reader and venues for the current ring and filter; `restart` starts the tally over (read back in steps). */
  #syncSources(restart: boolean): void {
    const ring = this.ring(), s = this.store.state.trades, reader = this.blocks.reader, key = this.#filterKeyNow();
    const markets = this.#markets(ring);
    // A backlog larger than a read-back step (the view hidden a while) is read back in steps too, not in one call.
    if (restart || this.#tally.ring !== ring || key !== this.#filterKey || this.#tally.behind > FILL_STEP) {
      this.#filterKey = key; this.#ringGroupsFor = null;
      this.#tally.reset(ring, { minUsd: s.minUsd === 0 ? 0 : scaledUsd(s.minUsd), side: s.side, shown: instrumentShown(this.store.state) });
      // A held list stays held over the start-over, counting what comes from now.
      if (this.blocks.held) this.#tally.hold();
      this.#fill();
    }
    this.#tally.update();
    reader.markets = markets; reader.minUsd = s.minUsd === 0 ? 0 : scaledUsd(s.minUsd); reader.side = s.side;
    reader.ref = [...markets].sort((a, b) => refRank(a) - refRank(b))[0] ?? '';
    // Venue slots: one per exchange (spot and perpetual share it), the most traded first.
    const families = [...new Set(markets.map(id => markOf(id).family))].sort((a, b) => venueRank(a) - venueRank(b));
    this.#venueIds = families.map(f => markets.find(id => markOf(id).family === f && !markOf(id).spot) ?? markets.find(id => markOf(id).family === f)!);
    reader.setVenues(families.length, id => families.indexOf(markOf(id).family));
    reader.recorded = this.#recorded; reader.older = this.#older;
    reader.gaps = ring ? this.#gaps(ring) : [];
    this.blocks.venueIds = this.#venueIds; this.blocks.whale = this.#whale();
    this.#scratch = emptyBlock(families.length);
    // Any size reaches back through the page's per-second flow: ask for it (a local read the Flow lines make anyway).
    if (s.minUsd === 0 && markets.length) this.ensureFlow(markets, Date.now() - FLOW_REACH_MS);
    this.#syncLate();
  }
  /** The markets counted changed (they come in after the view opens): the reader and venues follow; any size asks for their history (a no-op once held). */
  #syncMarkets(): void {
    const markets = this.#markets(this.ring()), reader = this.blocks.reader;
    if (markets.join() !== reader.markets.join()) { this.#syncSources(false); this.blocks.invalidate(); return; }
    if (this.store.state.trades.minUsd === 0 && markets.length) { this.ensureFlow(markets, Date.now() - FLOW_REACH_MS); this.#askHoles(); }
  }
  /**
   * Where the recording listened to no market, over the day the flow reaches back, up to the tape's covered start (after it the tape is the
   * source and says its own gaps): asked when the tape has begun, and again when it starts later (a ring started over). The flow holds
   * zeros for seconds nobody recorded (one such stretch comes at every opening, between the history's end and the page's own recording),
   * so a block over one is drawn partial, and a run of blocks wholly in one is a line.
   */
  #askHoles(): void {
    const cov = this.#tally.coveredFrom(), markets = this.blocks.reader.markets;
    // Asked again once the tape's start has moved well past what was asked up to (a ring that wraps moves it by the second): ten minutes.
    if (this.#holesState === 'done' && cov - this.#holesTo > HOLES_AGAIN_MS) this.#holesState = 'no';
    // The flow loaded again (the history landed, a reconnect) or a market came: the record may say more now (a minute apart at most).
    if (this.#holesState === 'done' && (this.flowLoads() !== this.#holesLoads || markets.join() !== this.#holesMarkets) && Date.now() - this.#holesAskedAt > 60_000) this.#holesState = 'no';
    if (!this.holes || this.#holesState !== 'no' || !markets.length || !Number.isFinite(cov) || Date.now() < this.#holesRetryAt) return;
    this.#holesState = 'asking';
    const to = Math.min(Date.now(), cov);
    this.#holesTo = to; this.#holesLoads = this.flowLoads(); this.#holesMarkets = markets.join(); this.#holesAskedAt = Date.now();
    this.holes(markets, to - FLOW_REACH_MS, to).then(answer => {
      this.#holesState = 'done';
      const holes = answer?.holes ?? [], sinceOf = answer?.sinceOf ?? {};
      const key = `${holes.map(h => h.join('-')).join(',')}|${Object.entries(sinceOf).sort().map(([id, t]) => `${id}=${t}`).join(',')}`;
      // The kept blocks are read again only when what the recording says changed.
      if (key === this.#holesKey) return;
      this.#holesKey = key; this.#sinceOf = new Map(Object.entries(sinceOf));
      const reader = this.blocks.reader;
      reader.holes = holes; reader.knownKey = key; reader.forget(); this.blocks.invalidate(); this.#inspect();
    }, () => { this.#holesState = 'no'; this.#holesRetryAt = Date.now() + 30_000; });
  }
  /** Read the tape back a step at a time until the tally holds all of it (never a whole ring in one frame). */
  #fill(): void {
    window.clearTimeout(this.#fillTimer);
    if (!this.#tally.filling) return;
    this.#tally.fill(FILL_STEP);
    this.blocks.invalidate();
    if (this.#tally.filling) { this.#fillTimer = window.setTimeout(() => this.#fill(), 0); return; }
    // Done: the covered start has moved back to the ring's start, and what was read across it meanwhile is read again.
    this.blocks.reader.forget();
  }
  /** Where orders may be missing (exchange ms): around each reconnect, skipped or trimmed batch the ring holds. */
  #gaps(ring: TapeRing): [number, number][] {
    const out: [number, number][] = [], first = ring.first;
    for (const b of ring.boundaries) {
      if (!(b.reasons & (BOUNDARY.reconnect | BOUNDARY.skipped | BOUNDARY.trimmed | BOUNDARY.cleared)) || b.before <= first || b.before >= ring.written) continue;
      const tb = ring.t0 + ring.data[((b.before - 1) % ring.capacity) * STRIDE]!, ta = ring.t0 + ring.data[(b.before % ring.capacity) * STRIDE]!;
      out.push([Math.min(tb, ta), Math.max(tb, ta) + (b.reasons & BOUNDARY.trimmed ? 250 : 0)]);
    }
    return out;
  }
  #syncLate(): void {
    const ring = this.#tally.ring, names = ring ? [...new Set(this.#tally.late().map(m => venueLabel(markOf(ring.ids[m] ?? '').family)))] : [];
    if (names.join() !== this.blocks.late.join()) { this.blocks.late = names; this.blocks.invalidate(); }
  }
  /** The recording's orders for the hour before the tape (from $25K, or the size chosen when larger): asked when the view first needs them, and again when the size is lowered below what was asked. */
  /** The smallest size the recording is wanted from: $25K, or the size chosen when larger. */
  #recordedWant(): number { const s = this.store.state.trades; return Math.max(scaledUsd(TNS_FLOOR_USD), s.minUsd === 0 ? 0 : scaledUsd(s.minUsd)); }
  #askRecorded(): void {
    if (!this.recorded || !this.#shown) return;
    const ring = this.ring(), want = this.#recordedWant();
    // Up to the seam where the tape takes over for this view (`trades/asks.ts`), asked again only when the seam moved five minutes past
    // where it was asked (a wrapping ring, a sliding tally window), a smaller size is wanted, or a failure's wait is over.
    const seam = recordedSeam({ blocks: this.#unitNow() > 0, ringFrom: ring && ring.written ? ring.heldFrom : null, covered: this.#tally.coveredFrom(), filling: this.#tally.filling });
    if (seam === null) return;
    const ask = { state: this.#recordedState, askedAt: this.#recordedAt, min: this.#recordedMin, retryAt: this.#recordedRetryAt };
    if (!recordedDue(ask, seam, want, Date.now())) return;
    this.#recordedState = 'asking'; this.#recordedAt = seam;
    void this.recorded(seam, want).then(answer => {
      this.#recordedState = 'done'; this.#recordedMin = want;
      const prints = answer ? [...answer.prints].sort((a, b) => a.t - b.t) : [];
      // The answer holds the recording's orders a few seconds past the seam (SEAM_SLACK_MS): that is where it ends.
      this.#recorded = answer ? { prints, from: answer.from, to: seam + SEAM_SLACK_MS, holes: answer.holes, minUsd: want } : null;
      this.#recordedRaw = answer ? { prints, seam, minHole: answer.minHole } : null;
      this.blocks.reader.recorded = this.#recorded; this.blocks.reader.forget(); this.blocks.invalidate(); this.#inspect();
      this.#syncHistory();
      // The size was lowered while the question was out: asked again for it (nothing else makes it due at once).
      if (this.#recordedWant() < want) this.#askRecorded();
    }, () => { this.#recordedState = 'no'; this.#recordedRetryAt = Date.now() + 30_000; });
  }
  #recordedRaw: { prints: Print[]; seam: number; minHole: number } | null = null;
  /**
   * Any size, blocks drawn before the recording's hour (their totals come from the per-second flow): the stretch on screen, with a margin,
   * is asked of the recording for their largest orders. A busy stretch holds more orders than an answer carries, so it keeps the largest,
   * and a block's largest buy and sell are among them unless the block is far quieter than the stretch. One question at a time; the last
   * few stretches are kept (scrolling back over them asks nothing).
   */
  #askOlder(s0: number, s1: number): void {
    this.#olderWant = [s0, s1];
    if (!this.printsIn || this.#olderAsking || this.store.state.trades.minUsd !== 0 || this.#unitNow() === 0 || Date.now() < this.#olderRetryAt) return;
    const rec = this.#recorded, before = Math.min(rec ? rec.from : Infinity, this.#tally.coveredFrom(), Date.now());
    const a = s0 * 1000, b = Math.min(s1 * 1000, before);
    if (!(b > a) || olderFor(this.#older, a, b)) return;
    const unit = this.#unitNow() * 1000, margin = Math.max(unit, OLDER_MARGIN_MS, (b - a) / 2);
    const from = Math.floor((a - margin) / unit) * unit, to = Math.ceil((b + margin) / unit) * unit, floor = scaledUsd(TNS_FLOOR_USD);
    this.#olderAsking = true;
    this.printsIn(from, to, floor).then(answer => {
      const prints = [...answer.prints].sort((x, y) => x.t - y.t);
      this.#older = [...this.#older.slice(1 - OLDER_KEPT), { from, to, prints, floor: Math.max(floor, answer.floor) }];
      this.blocks.reader.older = this.#older; this.blocks.reader.forget(); this.blocks.invalidate(); this.#inspect();
    }, () => { this.#olderRetryAt = Date.now() + 10_000; }).finally(() => {
      // What was drawn meanwhile (a list scrolled on) is asked next, at once (the one-second tick asks again after a failure).
      this.#olderAsking = false;
      const want = this.#olderWant;
      if (want) this.#askOlder(want[0], want[1]);
    });
  }
  /**
   * Each order from the recording's floor up: the recording's orders before the tape (Time & sales' hour, with its holes as lines, `TnsBook`)
   * continue the list below the tape's oldest order. Under the floor the list ends where the tape starts.
   */
  #syncHistory(): void {
    const s = this.store.state.trades, floor = s.minUsd === 0 ? 0 : scaledUsd(s.minUsd), raw = this.#recordedRaw, rec = this.#recorded;
    if (!raw || !rec || floor < rec.minUsd) { this.orders.history = []; this.orders.historyNote = ''; this.orders.invalidate(); return; }
    const book = new TnsBook(raw.seam);
    book.prefill(raw.prints, rec.from, rec.holes, raw.minHole);
    this.orders.history = book.rows({ minUsd: floor, side: s.side, merge: s.group, shown: instrumentShown(this.store.state) }).filter(l => l.k === 'gap' || l.t < raw.seam);
    this.orders.historyNote = t('Recorded orders from ${usd} before {time}, when this page began listening', { usd: fmtUsd(rec.minUsd), time: clockSeconds(raw.seam) });
    this.orders.invalidate();
  }

  // ---- layout, status, hover, inspector ---------------------------------------------------------------------------------------------

  #barW = 0;
  #layout(): void {
    const w = this.#body.getBoundingClientRect().width, wide = !isPhone() && this.#unitNow() > 0 && wideEnough(w);
    this.#barW = this.#bar.getBoundingClientRect().width;
    this.root.classList.toggle('wide', wide);
    this.#inspector.hidden = !wide;
    this.blocks.root.style.flexBasis = wide ? `${LIST_W}px` : '';
    if (wide) this.#inspect();
  }
  #syncStatus(): void {
    const unit = this.#unitNow();
    if (unit === 0) { setText(this.#status, this.orders.since); return; }
    // Held, the count is on the list's key (which brings it back), as Each order's; the status keeps the scale.
    this.blocks.showHeld(this.blocks.held ? this.#tally.newSinceHold : 0);
    const full = fmtUsd(scaledUsd(fullScale(unit)));
    // The bar's width from the last layout (the resize observer's), not measured here: this runs every second, and a measure forces a layout.
    setText(this.#status, this.#barW < 320 ? `√ $${full}` : t('√ size, full ${usd}', { usd: full }));
    const tip = t('Each bar\'s length is the square root of its dollars, full at ${usd} a side: a side ten times larger draws about three times longer. The pieces in a bar are the exchanges\' shares of that side.', { usd: full });
    if (this.#status.dataset.tip !== tip) this.#status.dataset.tip = tip;
  }
  #hover(b: Block | null): void {
    const hover = this.store.state.hover;
    if (!b) { if (hover?.source === 'trades') this.store.set({ hover: null }); return; }
    const at = b.s * 1000 + b.B * 500;
    if (hover?.source === 'trades' && hover.t === at) return;
    this.store.set({ hover: { t: at, price: Number.isFinite(b.refPx) ? b.refPx : null, y: 0, source: 'trades' } });
  }
  /** The words where the block list ends, at second `oldest`: where the size's history starts, or where the sources do. */
  #endNote(oldest: number): string {
    const cov = this.blocks.reader.coveredSec(), s = this.store.state.trades;
    if (!Number.isFinite(oldest)) return '';
    const at = this.#unitNow() >= 60 ? clock(oldest * 1000) : clockSeconds(oldest * 1000);
    if (s.minUsd > 0 && oldest >= cov) return t('Blocks from ${usd} start at {time}, when this page began listening', { usd: fmtUsd(scaledUsd(s.minUsd)), time: at });
    if (s.minUsd > 0) return t('Recorded orders start at {time}', { time: at });
    return t('The page\'s per-second record starts at {time}', { time: at });
  }
  /**
   * Draw the inspector for the chosen block, else the newest settled one (beside a wide list). It is asked once a second; the block's orders
   * are read again only when something it shows can have changed (its seconds' revisions in the tally, the reader's sources, the flow's
   * loads, the size, the side, the language), so a settled block costs a key a second, not a pass over its orders and a page rebuild.
   */
  #inspect(): void {
    if (this.#inspector.hidden || this.#unitNow() === 0 || !this.#shown) return;
    const plan = this.#plan(null, true);
    if (!plan) return;
    // The pass over the block's orders runs in slices of a few milliseconds (a settled minute holds 30,000 orders and more; in one task
    // it took a frame or two every minute): the inspector shows the last block until it ends, and a newer block or change starts over.
    window.clearTimeout(this.#jobTimer); this.#job = plan;
    this.#slice();
  }
  #job: Plan | null = null; #jobTimer = 0;
  /** A pass left unfinished (the view hidden): its key is forgotten, so the inspector works the block out again when it shows. */
  #dropJob(): void { window.clearTimeout(this.#jobTimer); if (this.#job) { this.#job = null; this.#inspected = ''; } }
  #slice(): void {
    const job = this.#job;
    if (!job) return;
    if (!this.#shown) { this.#dropJob(); return; }
    // The ring rebased between two slices (its stored times moved): the pass starts over rather than read the rest hours off.
    if ((this.ring()?.epoch ?? -1) !== job.epoch) { this.#dropJob(); this.#inspect(); return; }
    const end = performance.now() + SLICE_MS;
    while (performance.now() < end) {
      if (job.steps.next().done) { this.#job = null; renderInspector(this.#inspector, this.#finish(job)); return; }
    }
    this.#jobTimer = window.setTimeout(() => this.#slice(), 0);
  }
  /** The tally's revisions of a block's seconds added up: it grows with every order counted into them (a key, not a figure). */
  #revs(s: number, B: number): number {
    const tally = this.#tally;
    let r = 0;
    for (let sec = s; sec < s + B; sec++) { const sl = tally.slot(sec); if (sl >= 0) r += tally.rev(sl) + 1; }
    return r;
  }
  /** The inspector's model of block `sec` (null: the chosen one, else the newest settled), at once (a tap's sheet). */
  #model(sec: number | null): ReturnType<typeof inspectorModel> | null {
    const plan = this.#plan(sec, false);
    if (!plan) return null;
    while (!plan.steps.next().done) { /* the whole pass */ }
    return this.#finish(plan);
  }
  /**
   * A block's inspector, ready to be worked out: the block (a copy: other reads use the scratch block meanwhile), its time, and the pass
   * over its orders as steps. `keyed`: null when nothing it shows changed since the last.
   */
  #plan(sec: number | null, keyed: boolean): Plan | null {
    const blocks = this.blocks, reader = blocks.reader;
    if (reader.venues !== this.#scratch.vBuy.length) this.#scratch = emptyBlock(reader.venues);
    const saved = blocks.selected;
    if (sec !== null) blocks.selected = sec;
    const { block: read, state } = blocks.inspected(this.#scratch);
    blocks.selected = saved;
    if (read.unknown) { if (keyed) this.#inspected = ''; return null; }
    const unit = read.B, t0 = read.s * 1000, t1 = (read.s + unit) * 1000;
    if (keyed) {
      const key = `${state}|${read.s}|${unit}|${this.#tally.resets}|${this.#revs(read.s, unit)}|${reader.version}|${this.flowLoads()}|${reader.minUsd}|${reader.side}|${isPhone()}|${document.documentElement.lang}|${read.partial}`;
      if (key === this.#inspected) return null;
      this.#inspected = key;
    }
    const block = emptyBlock(reader.venues); copyBlock(read, block);
    const floor = reader.minUsd, big = Math.max(scaledUsd(100_000), floor), scan = keyed ? this.#scan : this.#sheetScan;
    scan.reset(isPhone() ? 4 : 9, floor, big);
    return { block, state, unit, t0, t1, floor, big, scan, epoch: this.ring()?.epoch ?? -1, steps: this.#scanSteps(scan, t0, t1) };
  }
  /** The model once the pass is over. */
  #finish(plan: Plan): ReturnType<typeof inspectorModel> {
    const { block, state, unit, t0, t1, floor, big, scan } = plan, reader = this.blocks.reader;
    const largest = scan.largest;
    const time = unit >= 60 ? `${clock(t0)}–${clock(t1)}` : unit === 1 ? clockSeconds(t0) : `${clockSeconds(t0)}–${clockSeconds(t1)}`;
    // The stretches of the block before the tape that nobody recorded (any size: the flow's zeros there are not quiet seconds).
    const cut = Math.min(t1, this.#tally.coveredFrom()), unrecorded = floor === 0 ? reader.holes.filter(([a, b]) => a < cut && b > t0).map(([a, b]) => [Math.max(a, t0), Math.min(b, cut)] as [number, number]) : [];
    return inspectorModel({
      block, state, time, marketCount: reader.markets.length, ref: reader.ref, minUsd: floor, recordedFloor: scaledUsd(TNS_FLOOR_USD),
      rows: reader.marketRows(block.s, unit), coincidences: coincidences(scan.big, big), repeats: scan.repeats(), largest, unrecorded,
    });
  }
  /** A market's group for the scan (one per id, whatever source names it). */
  #group(id: string): number { let g = this.#groupOf.get(id); if (g === undefined) { g = this.#groupOf.size; this.#groupOf.set(id, g); } return g; }
  /**
   * The orders of a stretch into the scan, for the notes and the largest orders: the tape's where it covers (read straight from the ring's
   * arrays, at most NOTE_ORDERS_MAX, the newest), else the recording's. A step every SLICE_ORDERS orders looked at, counted or not (a high
   * floor skips most of them; the caller decides when to go on).
   */
  *#scanSteps(scan: OrderScan, t0: number, t1: number): Generator<void, void, void> {
    const ring = this.ring(), shown = instrumentShown(this.store.state), cov = this.#tally.coveredFrom();
    // The block's own filter: its side and its smallest order (the notes and the largest orders describe what the block counts).
    const reader = this.blocks.reader, side = reader.side, floor = reader.minUsd;
    const passes = (usd: number): boolean => !((side === 'buy' && usd < 0) || (side === 'sell' && usd > 0) || (floor > 0 && Math.abs(usd) < floor));
    if (ring && ring === this.#tally.ring && t1 > cov) {
      if (this.#ringGroupsFor !== ring) { this.#ringGroupsFor = ring; this.#ringGroups = []; }
      const groups = this.#ringGroups, d = ring.data, cap = ring.capacity, rt0 = ring.t0, p0 = ring.p0;
      // Each market's group, or -1 when it is not shown, once per ring index (the venues shown can change: the list is made again then).
      while (groups.length < ring.ids.length) { const id = ring.ids[groups.length]!; groups.push(shown(id) ? this.#group(id) : -1); }
      let read = 0, seen = 0;
      for (const [a, b] of ring.runs(Math.max(t0, cov), t1 - 1)) {
        for (let k = Math.max(a, b - NOTE_ORDERS_MAX); k < b && read < NOTE_ORDERS_MAX; k++) {
          if (++seen % SLICE_ORDERS === 0) yield;
          const at = (k % cap) * STRIDE, tt = rt0 + d[at]!;
          if (tt < t0 || tt >= t1) continue;
          const m = d[at + 3]!, g = groups[m] ?? -1;
          if (g < 0 || !passes(d[at + 2]!)) continue;
          scan.add(g, ring.ids[m]!, tt, d[at + 2]!, p0 + d[at + 1]!, p0 + d[at + 4]!, p0 + d[at + 5]!); read++;
        }
      }
    }
    const rec = this.#recorded, put = (p: PrintLike): void => { const usd = p.side === 'buy' ? p.usd : -p.usd; if (passes(usd)) scan.add(this.#group(p.id), p.id, p.t, usd, p.price, p.lo ?? p.price, p.hi ?? p.price); };
    if (rec && t0 < cov) for (const p of rec.prints) if (p.t >= t0 && p.t < Math.min(t1, cov) && shown(p.id)) put(p);
    // Before the recording's hour (any size): the older stretch asked for the blocks on screen.
    const cut = Math.min(t1, cov, rec ? rec.from : Infinity), w = t0 < cut && this.store.state.trades.minUsd === 0 ? olderFor(this.#older, t0, cut) : undefined;
    if (w) for (const p of w.prints) if (p.t >= t0 && p.t < cut && shown(p.id)) put(p);
  }
  #sheet(s: number): void {
    const model = this.#model(s);
    if (!model) return;
    openSheet(model.title, body => { body.classList.add('trades-inspector', 'in-sheet'); renderInspector(body, model); }, () => { this.blocks.release(); });
  }
}

const venueRank = (family: string): number => { const i = VENUE_ORDER.indexOf(family); return i < 0 ? VENUE_ORDER.length : i; };
/** A market's place as the reference: its perpetual or spot entry in REF_ORDER (a venue that lists only spot, as Coinbase, by its own name). */
export function refRank(id: string): number {
  const m = markOf(id);
  let i = REF_ORDER.indexOf(m.spot ? `${m.family}spot` : m.family);
  if (i < 0 && m.spot) i = REF_ORDER.indexOf(m.family);
  return i < 0 ? REF_ORDER.length : i;
}
