import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BANDS, HH, NOW_PRICE, ROWS, SEED, SNAPS, bandIndex, createData, demoData, forgetData, mulberry32, whenData, type DemoData } from '../src/app/plus/demo/data.ts';
import { DEMO_START, createDemoStore, kindsOn, lastOn, type DemoLevels, type DemoStore } from '../src/app/plus/demo/store.ts';
import { bucketsOf, depthColumns, depthTable, levelsAt, weightsOf, windowEnd } from '../src/app/plus/demo/model.ts';
import { Player, SCENES, idleCaption, type SceneStep } from '../src/app/plus/demo/scenes.ts';
import { mountDemo } from '../src/app/plus/demo/demo.ts';
import { mountVisuals } from '../src/app/plus/demo/visuals.ts';

/* ==== the made-up numbers ============================================================================================================= */

const round = (v: number, digits = 4): number => Number(v.toPrecision(digits));
const sum = (a: ArrayLike<number>): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]!; return s; };

test('the demo\'s numbers come from one seed: the same numbers every time, others for another seed', () => {
  const a = createData(SEED), b = createData(SEED), other = createData(SEED + 1);
  for (const key of ['price', 'liqL', 'liqS', 'stopL', 'stopS', 'tpL', 'tpS', 'pfLiq', 'pfStop', 'pfTp', 'band'] as const) {
    assert.deepEqual(Buffer.from(a[key].buffer), Buffer.from(b[key].buffer), `${key}: the same bytes`);
  }
  assert.notDeepEqual(Buffer.from(a.liqL.buffer), Buffer.from(other.liqL.buffer), 'another seed, other levels');
  assert.equal(demoData(), demoData(), 'built once and shared');
  // The generator itself, and a few numbers pinned (to four figures: the trace goes through Math.exp and Math.log).
  const r = mulberry32(1);
  assert.deepEqual([r(), r(), r()].map(v => round(v, 6)), GOLDEN.mulberry);
  assert.equal(a.price.length, HH);
  assert.equal(a.price[HH - 1], NOW_PRICE, 'the trace ends at the price now');
  assert.deepEqual([a.price[0], a.price[300], a.price[700]].map(v => round(v!)), GOLDEN.prices);
  assert.deepEqual([sum(a.liqL), sum(a.liqS), sum(a.stopL), sum(a.stopS), sum(a.tpL), sum(a.tpS)].map(v => round(v)), GOLDEN.sums);
  assert.deepEqual([a.band[bandIndex(SNAPS - 1, 0, 0, 0, 4)], a.band[bandIndex(SNAPS - 1, 1, 0, 1, 2)]].map(v => round(v!)), GOLDEN.bands);
  for (const key of ['pfLiq', 'pfStop', 'pfTp'] as const) for (const v of a[key]) assert.ok(v > 0 && v < 1, `${key}: a share`);
});

/** Pinned from the generator as ported from the approved prototype (seed 20261118; its arrays were byte-identical to the prototype's). */
const GOLDEN = { mulberry: [0.627074, 0.00273572, 0.527447], prices: [65_230, 66_720, 66_450], sums: [4.311e10, 3.629e10, 5.163e9, 5.75e9, 7.19e9, 7.714e9], bands: [1.155e8, 5.238e6] };

/* ==== the store ======================================================================================================================= */

test('the store: one kind always stays on, judged on the whole patch; other values are left out; told only of real changes', () => {
  const store = createDemoStore();
  const told: DemoLevels[] = [];
  const stop = store.subscribe(s => told.push(s));
  assert.deepEqual(store.get(), DEMO_START, 'every kind, everyone');
  assert.equal(store.set({ liq: false }), true);
  assert.equal(store.set({ stops: false }), true);
  assert.deepEqual(store.get(), { liq: false, stops: false, takes: true, traders: 'everyone' });
  assert.equal(lastOn(store.get(), 'takes'), true);
  assert.equal(store.set({ takes: false }), false, 'the last kind on stays on');
  assert.deepEqual(store.get(), { liq: false, stops: false, takes: true, traders: 'everyone' });
  assert.equal(store.set({ takes: false, stops: true }), true, 'one off and another on at once is fine');
  assert.deepEqual(store.get(), { liq: false, stops: true, takes: false, traders: 'everyone' });
  assert.equal(store.set({ liq: false, stops: false, takes: false, traders: 'profitable' }), true, 'all off: the kinds stay, the traders change');
  assert.deepEqual(store.get(), { liq: false, stops: true, takes: false, traders: 'profitable' });
  assert.equal(store.set({ stops: true }), false, 'no change, nobody told');
  const n = told.length;
  assert.equal(store.set({ liq: 'yes' as unknown as boolean, traders: 'nobody' as unknown as DemoLevels['traders'] }), false, 'values of the wrong kind are left out');
  assert.equal(told.length, n);
  assert.equal(told.length, 4);
  assert.ok(Object.isFrozen(store.get()), 'a frozen choice: kept and compared, never changed in place');
  stop();
  store.set({ liq: true });
  assert.equal(told.length, 4, 'unsubscribed');
  assert.deepEqual(createDemoStore({ liq: false, stops: false, takes: false, traders: 'profitable' }).get(), DEMO_START, 'a start with no kind on is the usual start');
  assert.equal(kindsOn({ liq: true, stops: false, takes: true, traders: 'everyone' }), 2);
});

/* ==== the curve =========================================================================================================================== */

const COMBOS: DemoLevels[] = [];
for (const traders of ['everyone', 'profitable'] as const) for (let m = 1; m < 8; m++) COMBOS.push({ liq: !!(m & 1), stops: !!(m & 2), takes: !!(m & 4), traders });

test('the curve adds up the liquidations and/or stops that are on, never take profits; take profits alone get their own curve', () => {
  const d = demoData(), bk = bucketsOf(1), n = bk.length;
  for (const end of [windowEnd(1), windowEnd(0.3), windowEnd(0)]) {
    for (const s of COMBOS) {
      const L = levelsAt(d, bk, end, weightsOf(s)), pb = L.pb, label = `${JSON.stringify(s)} at ${end}`;
      const alone = s.takes && !s.liq && !s.stops;
      let up = 0, upT = 0;
      for (let b = pb; b < n; b++) {
        up += (s.liq ? L.lS[b]! : 0) + (s.stops ? L.sS[b]! : 0); upT += L.tL[b]!;
        assert.ok(Math.abs(L.cU[b]! - up) <= 1e-6 * Math.max(1, up), `${label}: the curve above at ${b}`);
        assert.ok(Math.abs(L.tU[b]! - (alone ? upT : 0)) <= 1e-6 * Math.max(1, upT), `${label}: take profits' own curve above at ${b}`);
      }
      let dn = 0, dnT = 0;
      for (let b = pb; b >= 0; b--) {
        dn += (s.liq ? L.lL[b]! : 0) + (s.stops ? L.sL[b]! : 0); dnT += L.tS[b]!;
        assert.ok(Math.abs(L.cD[b]! - dn) <= 1e-6 * Math.max(1, dn), `${label}: the curve below at ${b}`);
        assert.ok(Math.abs(L.tD[b]! - (alone ? dnT : 0)) <= 1e-6 * Math.max(1, dnT), `${label}: take profits' own curve below at ${b}`);
      }
      if (alone) assert.equal(Math.max(...L.cU, ...L.cD), 0, `${label}: take profits alone: no solid curve`);
      // Take profits never change the solid curve.
      if (s.liq || s.stops) {
        const other = levelsAt(d, bk, end, weightsOf({ ...s, takes: !s.takes }));
        assert.deepEqual([...other.cU], [...L.cU], `${label}: the curve above, take profits on or off`);
        assert.deepEqual([...other.cD], [...L.cD], `${label}: the curve below, take profits on or off`);
      }
      assert.ok(L.cumMax >= Math.max(...L.cU, ...L.cD, ...L.tU, ...L.tD) - 1e-6);
    }
  }
});

test('the profitable traders are drawn as precisely as everyone, price by price, with their own smaller amounts', () => {
  const d = demoData(), bk = bucketsOf(1), end = windowEnd(1);
  const all = levelsAt(d, bk, end, weightsOf(DEMO_START)), pf = levelsAt(d, bk, end, weightsOf({ ...DEMO_START, traders: 'profitable' }));
  const ratios: number[] = [];
  for (let b = 0; b < bk.length; b++) {
    for (const k of ['lS', 'lL', 'sS', 'sL', 'tL', 'tS'] as const) {
      assert.ok(pf[k][b]! <= all[k][b]! + 1e-6, `${k} ${b}: no more than everyone`);
      if (all[k][b]! > 1e5) ratios.push(pf[k][b]! / all[k][b]!);
    }
  }
  assert.ok(ratios.length > 50);
  assert.ok(Math.max(...ratios) - Math.min(...ratios) > 0.3, 'a shape of their own, not everyone scaled down');
  const table = depthTable(d, end, weightsOf(DEMO_START)), pfTable = depthTable(d, end, weightsOf({ ...DEMO_START, traders: 'profitable' }));
  BANDS.forEach((_, k) => { assert.ok(pfTable.up[k]! < table.up[k]!); assert.ok(pfTable.dn[k]! < table.dn[k]!); });
  for (let k = 1; k < BANDS.length; k++) assert.ok(table.up[k]! >= table.up[k - 1]!, 'a wider distance holds at least as much');
  const depth = depthColumns(d, end - 336, end, weightsOf(DEMO_START));
  assert.equal(depth.cols.length, 85, 'a column for each snapshot of the week (the first one partly in it)');
  assert.ok(depth.cols.every(c => c.up.length === BANDS.length && c.dn.length === BANDS.length));
  assert.equal(ROWS * SNAPS, d.liqL.length);
});

/* ==== the scenes ========================================================================================================================== */

test('the scenes and their captions are the approved prototype\'s', () => {
  assert.deepEqual(SCENES.map(s => s.label()), ['Liquidations', 'Stops', 'Take profits', 'Each alone', 'Traders', 'History']);
  assert.deepEqual(SCENES.flatMap(s => s.steps.flatMap(st => st.caption ? [st.caption()] : [])), [
    'Liquidation levels at each price.', 'Add stop losses to the curve.', 'Take profits get their own lane.', 'Choose each kind on its own.',
    'Take profits alone get a dashed curve.', 'Profitable traders, at each price.', 'Scroll back through the whole history.']);
  assert.equal(idleCaption(), 'Try the switches.');
  assert.deepEqual(SCENES.map(s => s.dur), [4000, 4000, 4000, 6000, 7000, 7000]);
});

/** A player on a store, frame by frame. */
function played() {
  const store = createDemoStore(), applied: { step: SceneStep; animate: boolean; at: number }[] = [];
  let clock = 0, idle = 0;
  const player = new Player({ apply(step, animate) { applied.push({ step, animate, at: clock }); if (step.set) store.set(step.set); }, idle() { idle++; } });
  const run = (ms: number, frame = 16): void => { for (let t = 0; t < ms; t += frame) { clock += frame; player.tick(clock); } };
  return { store, applied, player, run, now: () => clock, idles: () => idle };
}

test('the scenes apply their steps in order, at their times, and the tour stops by itself at its end', () => {
  const p = played();
  const states: DemoLevels[] = [];
  p.store.subscribe(s => states.push(s));
  p.player.start(p.now());
  assert.equal(p.applied.length, 1, 'the first step at once');
  p.run(p.player.total + 500);
  assert.deepEqual(p.applied.map(a => a.step), p.player.steps, 'every step, in order');
  const expected = p.player.steps.map(s => s.at);
  p.applied.forEach((a, i) => { assert.ok(a.at >= expected[i]! && a.at < expected[i]! + 17, `step ${i} at ${a.at}, due at ${expected[i]}`); assert.equal(a.animate, true); });
  assert.deepEqual(states.map(s => [+s.liq, +s.stops, +s.takes, s.traders]), [
    [1, 0, 0, 'everyone'], [1, 1, 0, 'everyone'], [1, 1, 1, 'everyone'], [0, 1, 0, 'everyone'], [0, 0, 1, 'everyone'], [1, 1, 1, 'everyone'], [1, 1, 1, 'profitable'], [1, 1, 1, 'everyone']]);
  assert.equal(p.player.running, false);
  assert.equal(p.player.pausedBy, 'end');
  assert.equal(p.idles(), 1, 'the caption goes back to its invitation once');
  assert.equal(p.player.current(), SCENES.length - 1);
  assert.deepEqual(SCENES.map((_, i) => p.player.progress(i)), [1, 1, 1, 1, 1, 1]);
});

test('a late frame counts as 100 ms; a pause holds the tour; a scene chosen by hand shows its end at once, paused', () => {
  const p = played();
  p.player.start(0);
  p.player.tick(5000);
  assert.equal(p.player.position, 100, 'a tab that slept does not skip scenes');
  p.player.pause('view');
  p.run(20_000);
  assert.equal(p.player.position, 100);
  assert.equal(p.player.pausedBy, 'view');
  p.player.resume(p.now());
  p.run(4000);
  assert.equal(p.player.current(), 1);
  p.player.interrupt();
  assert.equal(p.player.running, false);
  assert.equal(p.player.pausedBy, 'user');
  p.applied.length = 0;
  p.player.jump(4);
  assert.equal(p.applied.length, 1, 'one step that does it all');
  assert.equal(p.applied[0]!.animate, false);
  assert.deepEqual(p.store.get(), { liq: true, stops: true, takes: true, traders: 'profitable' });
  assert.equal(p.applied[0]!.step.caption!(), 'Profitable traders, at each price.');
  assert.equal(p.applied[0]!.step.scrub, 1);
  p.player.jump(5);
  assert.equal(p.applied[1]!.step.scrubTo, 0.2, 'the history scene glides back');
  assert.equal(p.applied[1]!.step.scrub, undefined);
  assert.equal(p.player.pausedBy, 'user');
  p.run(10_000);
  assert.equal(p.applied.length, 2, 'and stays where it was put');
  p.player.resume(p.now());
  p.run(2000);
  assert.equal(p.player.running, false, 'resumed one frame before its end: it ends');
  p.player.resume(p.now());
  assert.equal(p.player.running, true, 'after its end, Play starts it again');
  assert.equal(p.player.position, 0);
});

/* ==== mounted, on a page made of plain objects ============================================================================================ */

/**
 * Errors thrown after a hand-out (whenData throws a waiter's error again in a microtask) that no test read with `page.microtasks()`: the
 * fake page keeps them when it goes, and the check after each test fails that test with them. An error a test expects, it reads itself.
 */
const leftOver: unknown[] = [];
afterEach(() => {
  const errors = leftOver.splice(0);
  if (errors.length) throw new assert.AssertionError({ message: `errors thrown after a hand-out that the test did not read: ${errors.map(e => (e instanceof Error ? e.message : String(e))).join('; ')}`, actual: errors.length, expected: 0, operator: 'strictEqual' });
});

type Listener = (event: FakeEvent) => void;
interface FakeEvent { type: string; key?: string; clientX?: number; pointerId?: number; preventDefault(): void }

class FakeNode {
  parent: FakeElement | null = null;
  constructor(public text = '') {}
  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = v; }
  remove(): void { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
}

class FakeElement extends FakeNode {
  children: FakeNode[] = [];
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners = new Map<string, Set<Listener>>();
  hidden = false; tabIndex = -1; type = '';
  constructor(readonly tagName: string, readonly env: FakePage) { super(); }
  get id(): string { return this.attrs.get('id') ?? ''; }
  set id(v: string) { this.attrs.set('id', v); }
  get className(): string { return this.attrs.get('class') ?? ''; }
  set className(v: string) { this.attrs.set('class', v); }
  get classList() {
    const names = (): string[] => this.className.split(/\s+/).filter(Boolean);
    const write = (list: string[]): void => { this.className = list.join(' '); };
    return {
      add: (...c: string[]) => write([...new Set([...names(), ...c])]),
      remove: (...c: string[]) => write(names().filter(x => !c.includes(x))),
      toggle: (c: string, force?: boolean) => { const on = force ?? !names().includes(c); write(on ? [...new Set([...names(), c])] : names().filter(x => x !== c)); return on; },
      contains: (c: string) => names().includes(c),
    };
  }
  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  get textContent(): string { return this.children.map(c => c.textContent).join(''); }
  set textContent(v: string) { for (const c of this.children) c.parent = null; this.children = v ? [this.adopt(new FakeNode(v))] : []; }
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  get clientWidth(): number { return this.env.width; }
  get offsetWidth(): number { return 0; }
  adopt(n: FakeNode | string): FakeNode { const node = typeof n === 'string' ? new FakeNode(n) : n; node.remove(); node.parent = this; return node; }
  append(...nodes: (FakeNode | string)[]): void { for (const n of nodes) this.children.push(this.adopt(n)); }
  appendChild<T extends FakeNode>(n: T): T { this.append(n); return n; }
  prepend(...nodes: (FakeNode | string)[]): void { this.children.unshift(...nodes.map(n => this.adopt(n))); }
  replaceChildren(...nodes: (FakeNode | string)[]): void { for (const c of this.children) c.parent = null; this.children = []; this.append(...nodes); }
  addEventListener(type: string, l: Listener): void { const set = this.listeners.get(type) ?? new Set(); set.add(l); this.listeners.set(type, set); }
  removeEventListener(type: string, l: Listener): void { this.listeners.get(type)?.delete(l); }
  fire(type: string, extra: Partial<FakeEvent> = {}): void { for (const l of [...this.listeners.get(type) ?? []]) l({ type, preventDefault() {}, ...extra }); }
  getBoundingClientRect() { return { left: 0, top: 0, right: this.env.width, bottom: 30, width: this.env.width, height: 30 }; }
  setPointerCapture(): void {}
  /** How long the browser would write this text (the page says how wide its words are). */
  getComputedTextLength(): number { return this.env.textWidth(this.textContent); }
  focus(): void {}
  /** Every element under this one. */
  all(): FakeElement[] { return this.children.flatMap(c => c instanceof FakeElement ? [c, ...c.all()] : []); }
}

/** The page, as the demo uses it: elements, frames, timers, observers, the media query, the tab's visibility; and what it counted. */
class FakePage {
  width = 700; reduced = false; hidden = false; clock = 1_000;
  /** How wide a text is written: six pixels a character unless a test says otherwise. */
  textWidth = (text: string): number => text.length * 6;
  frames = new Map<number, (t: number) => void>(); nextFrame = 1;
  timers = new Map<number, () => void>(); nextTimer = 1;
  idles = new Map<number, (deadline: { didTimeout: boolean; timeRemaining(): number }) => void>(); nextIdle = 1;
  resizes = new Set<object>(); views = new Map<object, (entries: unknown[]) => void>();
  docListeners = new Map<string, Set<Listener>>();
  /** The media queries asked for, each one object (as a browser keeps it), and who listens to its changes. */
  media = new Map<string, { matches: boolean; media: string; listeners: Set<() => void> }>();
  network: string[] = [];
  /** Work the page was asked to do right after the current task (queueMicrotask), run by `microtasks()`. */
  queued: (() => void)[] = [];
  #saved = new Map<string, PropertyDescriptor | undefined>();

  install(): void {
    const page = this;
    const document = {
      get hidden() { return page.hidden; },
      createElement: (tag: string) => new FakeElement(tag, page),
      createElementNS: (_ns: string, tag: string) => new FakeElement(tag, page),
      addEventListener: (type: string, l: Listener) => { const set = page.docListeners.get(type) ?? new Set(); set.add(l); page.docListeners.set(type, set); },
      removeEventListener: (type: string, l: Listener) => { page.docListeners.get(type)?.delete(l); },
    };
    const window = {
      get innerHeight() { return 800; },
      matchMedia: (q: string) => {
        let mq = page.media.get(q);
        if (!mq) {
          const listeners = new Set<() => void>();
          mq = { get matches() { return q.includes('reduced-motion') && page.reduced; }, media: q, listeners,
            addEventListener: (_type: string, l: () => void) => { listeners.add(l); }, removeEventListener: (_type: string, l: () => void) => { listeners.delete(l); } } as { matches: boolean; media: string; listeners: Set<() => void> };
          page.media.set(q, mq);
        }
        return mq;
      },
      setTimeout: (f: () => void) => { const id = page.nextTimer++; page.timers.set(id, f); return id; },
      clearTimeout: (id: number) => { page.timers.delete(id); },
      requestIdleCallback: (f: (deadline: { didTimeout: boolean; timeRemaining(): number }) => void) => { const id = page.nextIdle++; page.idles.set(id, f); return id; },
      cancelIdleCallback: (id: number) => { page.idles.delete(id); },
    };
    class ResizeObserver { constructor(readonly cb: () => void) {} observe() { page.resizes.add(this); } disconnect() { page.resizes.delete(this); } }
    class IntersectionObserver { constructor(readonly cb: (entries: unknown[]) => void) {} observe() { page.views.set(this, this.cb); } disconnect() { page.views.delete(this); } }
    const count = (name: string) => function blocked() { page.network.push(name); throw new Error(`${name}: no network in the demo`); };
    const values: Record<string, unknown> = {
      document, window, ResizeObserver, IntersectionObserver,
      requestAnimationFrame: (f: (t: number) => void) => { const id = page.nextFrame++; page.frames.set(id, f); return id; },
      cancelAnimationFrame: (id: number) => { page.frames.delete(id); },
      performance: { now: () => page.clock },
      queueMicrotask: (f: () => void) => { page.queued.push(f); },
      fetch: count('fetch'), XMLHttpRequest: count('XMLHttpRequest'), WebSocket: count('WebSocket'), EventSource: count('EventSource'), Image: count('Image'),
      navigator: { sendBeacon: count('sendBeacon'), languages: ['en'], language: 'en' },
    };
    for (const [k, v] of Object.entries(values)) { this.#saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k)); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
  }
  /** Take the page away: what is still queued for after the task runs first (while the page is there), and what it throws is kept for the
   * check after the test (`leftOver`), so an error nobody read fails the test that left it; the globals are put back whatever happens. */
  uninstall(): void {
    let thrown: unknown[] = [];
    try { thrown = this.microtasks(); } finally {
      for (const [k, d] of this.#saved) { if (d) Object.defineProperty(globalThis, k, d); else delete (globalThis as Record<string, unknown>)[k]; }
      this.#saved.clear();
      leftOver.push(...thrown);
    }
  }
  /** Run frames of 16 ms for `ms`, as the browser would while some are asked for. */
  run(ms: number): void {
    for (let t = 0; t < ms; t += 16) {
      this.clock += 16;
      const due = [...this.frames]; this.frames.clear();
      for (const [, f] of due) f(this.clock);
    }
  }
  /** The page goes idle: idle callbacks run, each with room for about twenty snapshots, and those they ask for in turn, at most `turns`. */
  idle(turns = 1_000): number {
    let n = 0;
    while (this.idles.size && n < turns) {
      const [id, f] = [...this.idles][0]!;
      this.idles.delete(id);
      let asked = 0;
      f({ didTimeout: false, timeRemaining: () => (asked++ < 20 ? 8 : 0) });
      n++;
    }
    return n;
  }
  /** Run the work queued for after the current task; what it threw, in order. */
  microtasks(): unknown[] {
    const thrown: unknown[] = [];
    // Until nothing is queued: a task may queue more (one that finishes a build with demoData() queues its waiters' errors), and those count.
    for (let batches = 0; this.queued.length; batches++) {
      if (batches > 10_000) throw new Error('tasks after the task keep queueing more');
      for (const f of this.queued.splice(0)) { try { f(); } catch (error) { thrown.push(error); } }
    }
    return thrown;
  }
  /** The demo shows this share of itself (and the window this tall). */
  view(ratio: number): void { for (const cb of [...this.views.values()]) cb([{ isIntersecting: ratio > 0, intersectionRatio: ratio, intersectionRect: { height: 500 * ratio }, rootBounds: { height: 800 } }]); }
  setHidden(hidden: boolean): void { this.hidden = hidden; for (const l of [...this.docListeners.get('visibilitychange') ?? []]) l({ type: 'visibilitychange', preventDefault() {} }); }
  listenerCount(): number { let n = 0; for (const set of this.docListeners.values()) n += set.size; for (const mq of this.media.values()) n += mq.listeners.size; return n; }
  /** The person turns reduced motion on or off: the media query says so to those listening. */
  setReduced(on: boolean): void { this.reduced = on; for (const mq of this.media.values()) for (const l of [...mq.listeners]) l(); }
}

/** The first element under `root` that carries the class `name`. */
const byClass = (root: FakeElement, name: string): FakeElement => { const found = root.all().find(e => e.classList.contains(name)); assert.ok(found, `.${name}`); return found; };

/** Mount the demo on a fake page with a control that hands its store out (the shape the app's control will have). */
function mounted(opts: { width?: number; reduced?: boolean; textWidth?: (text: string) => number } = {}) {
  demoData();
  const page = new FakePage();
  page.width = opts.width ?? 700; page.reduced = opts.reduced ?? false;
  if (opts.textWidth) page.textWidth = opts.textWidth;
  page.install();
  const host = new FakeElement('div', page);
  let store: DemoStore | null = null, controlHost: FakeElement | null = null, controlDestroyed = 0;
  const handle = mountDemo(host as unknown as HTMLElement, { control: (h, s) => { store = s; controlHost = h as unknown as FakeElement; return { destroy() { controlDestroyed++; } }; } });
  return { page, host, handle, store: () => store!, controlHost: () => controlHost!, controlDestroyed: () => controlDestroyed };
}

test('mounted: the tour plays once when the demo is 45 % in view, through the six scenes, into the demo\'s own store', () => {
  const m = mounted();
  try {
    const states: DemoLevels[] = [];
    m.store().subscribe(s => states.push(s));
    m.page.run(100);
    m.page.view(0.3);
    m.page.run(1000);
    assert.equal(states.length, 0, 'under 45 % in view: nothing plays');
    m.page.view(0.5);
    m.page.run(33_000);
    assert.deepEqual(states.map(s => [+s.liq, +s.stops, +s.takes, s.traders]), [
      [1, 0, 0, 'everyone'], [1, 1, 0, 'everyone'], [1, 1, 1, 'everyone'], [0, 1, 0, 'everyone'], [0, 0, 1, 'everyone'], [1, 1, 1, 'everyone'], [1, 1, 1, 'profitable'], [1, 1, 1, 'everyone']]);
    const caption = byClass(m.host, 'pd-caption');
    assert.equal(caption.textContent, 'Try the switches.', 'back to its invitation at the end');
    m.page.run(2000);
    assert.equal(m.page.frames.size, 0, 'nothing moves: no frame is asked for');
    m.page.view(0); m.page.view(0.9);
    m.page.run(10_000);
    assert.equal(states.length, 8, 'it played once');
  } finally { m.handle.destroy(); m.page.uninstall(); }
});

test('mounted: out of view or a hidden tab pauses the tour and coming back resumes it; the person\'s use stops it for good', () => {
  const m = mounted();
  try {
    const states: DemoLevels[] = [];
    m.store().subscribe(s => states.push(s));
    m.page.view(0.6);
    m.page.run(500);
    assert.equal(states.length, 1, 'the first scene');
    m.page.view(0.1);
    m.page.run(10_000);
    assert.equal(states.length, 1, 'out of view: paused');
    m.page.view(0.6);
    m.page.run(4000);
    assert.equal(states.length, 2, 'back in view: on to the second scene');
    m.page.setHidden(true);
    m.page.run(10_000);
    assert.equal(states.length, 2, 'the tab hidden: paused');
    m.page.setHidden(false);
    m.page.run(4000);
    assert.equal(states.length, 3);
    m.store().set({ liq: false });
    assert.equal(states.length, 4);
    m.page.run(20_000);
    assert.equal(states.length, 4, 'a change from the control stops the tour');
    m.page.view(0); m.page.view(0.8);
    m.page.run(20_000);
    assert.equal(states.length, 4, 'and coming back into view does not restart it');
  } finally { m.handle.destroy(); m.page.uninstall(); }
});

test('mounted: a press on the control or on the history stops the tour; under reduced motion it never starts by itself', () => {
  for (const target of ['control', 'history'] as const) {
    const m = mounted();
    try {
      const states: DemoLevels[] = [];
      m.store().subscribe(s => states.push(s));
      m.page.view(0.6);
      m.page.run(500);
      const track = m.host.all().find(e => e.getAttribute('role') === 'slider')!;
      if (target === 'control') m.controlHost().fire('pointerdown');
      else track.fire('pointerdown', { clientX: 10, pointerId: 1 });
      m.page.run(20_000);
      assert.equal(states.length, 1, `${target}: stopped`);
      if (target === 'history') assert.equal(track.getAttribute('aria-valuenow'), '0', 'the press moved the window to the oldest week');
    } finally { m.handle.destroy(); m.page.uninstall(); }
  }
  {
    // Used before it came into view: the tour never starts by itself over the person's choice.
    const m = mounted();
    try {
      const states: DemoLevels[] = [];
      m.store().subscribe(s => states.push(s));
      m.controlHost().fire('pointerdown');
      m.store().set({ takes: false });
      m.page.view(1);
      m.page.run(20_000);
      assert.deepEqual(states.map(s => s.takes), [false], 'only the change the person made');
    } finally { m.handle.destroy(); m.page.uninstall(); }
  }
  const m = mounted({ reduced: true });
  try {
    const states: DemoLevels[] = [];
    m.store().subscribe(s => states.push(s));
    m.page.view(1);
    m.page.run(20_000);
    assert.equal(states.length, 0, 'reduced motion: paused from the start');
    const play = m.host.all().find(e => e.tagName === 'button' && e.getAttribute('aria-label') === 'Play')!;
    play.fire('click');
    m.page.run(5000);
    assert.ok(states.length >= 2, 'Play starts it by hand');
  } finally { m.handle.destroy(); m.page.uninstall(); }
});

/** The element under `root` whose accessible name is `label`. */
const byLabel = (root: FakeElement, label: string): FakeElement => { const found = root.all().find(e => e.getAttribute('aria-label') === label); assert.ok(found, label); return found; };
/** Where the history window's left edge is, in per cent of the scrubber. */
const windowLeft = (root: FakeElement): number => parseFloat(byClass(root, 'pd-win').style.left!);

test('mounted: while the tour is paused its history scroll holds still (Pause, pause(), out of view) and goes on with it; the person taking over ends it', () => {
  // The History scene scrolls the window back from 25.9 s to 30.5 s of the tour; 28.5 s is in the middle of it. The reference plays the same
  // tour without a pause: after a pause, the window must be where the reference is after the same playing time, not further on.
  const reference = mounted();
  const along: number[] = [];
  try {
    reference.page.view(0.6);
    reference.page.run(28_500);
    along.push(windowLeft(reference.host));
    reference.page.run(16); along.push(windowLeft(reference.host));
    reference.page.run(384); along.push(windowLeft(reference.host));
  } finally { reference.handle.destroy(); reference.page.uninstall(); }
  const [atPause, oneFrameOn, later] = along as [number, number, number];
  assert.ok(atPause > 20 && atPause < 60, `in the middle of the scroll (${atPause})`);
  assert.ok(later < oneFrameOn && oneFrameOn < atPause && later > 13.333 + 5, `the reference is still on its way 400 ms on (${along.join(', ')})`);
  for (const how of ['Pause', 'pause()', 'out of view'] as const) {
    const m = mounted();
    try {
      m.page.view(0.6);
      m.page.run(28_500);
      assert.equal(windowLeft(m.host), atPause, `${how}: the same tour as the reference so far`);
      if (how === 'Pause') byLabel(m.host, 'Pause').fire('click');
      else if (how === 'pause()') m.handle.pause();
      else m.page.view(0.1);
      m.page.run(3000);
      assert.equal(windowLeft(m.host), atPause, `${how}: the window holds still`);
      assert.equal(m.page.frames.size, 0, `${how}: and no frame is asked for while paused`);
      if (how === 'out of view') m.page.view(0.6); else byLabel(m.host, 'Play').fire('click');
      assert.equal(windowLeft(m.host), atPause, `${how}: going on moves nothing by itself`);
      m.page.run(16);
      assert.equal(windowLeft(m.host), oneFrameOn, `${how}: one frame on, where the reference is one frame on (no jump)`);
      m.page.run(384);
      assert.equal(windowLeft(m.host), later, `${how}: 400 ms on, where the reference is 400 ms on: still on its way, not at its end`);
      m.page.run(4000);
      assert.equal(windowLeft(m.host), 13.333, `${how}: and ends where the scene sends it`);
    } finally { m.handle.destroy(); m.page.uninstall(); }
  }
  for (const how of ['control', 'scrubber key'] as const) {
    const m = mounted();
    try {
      m.page.view(0.6);
      m.page.run(28_500);
      if (how === 'control') m.controlHost().fire('pointerdown');
      else byLabel(m.host, 'History').fire('keydown', { key: 'ArrowLeft' });
      const left = windowLeft(m.host);
      m.page.run(5000);
      assert.equal(windowLeft(m.host), left, `${how}: the tour's scroll ends where the person took over`);
      byLabel(m.host, 'Play').fire('click');
      m.page.run(5000);
      assert.equal(windowLeft(m.host), left, `${how}: and Play goes on with the tour, not with the scroll it dropped`);
    } finally { m.handle.destroy(); m.page.uninstall(); }
  }
});

test('mounted: reduced motion turned on stops a tour that plays by itself, and it does not come back with the view; one the person started goes on', () => {
  {
    // Playing by itself, in the middle of the History scroll: it stops, and so does the window.
    const m = mounted();
    try {
      const states: DemoLevels[] = [];
      m.store().subscribe(s => states.push(s));
      m.page.view(0.6);
      m.page.run(28_500);
      const n = states.length, left = windowLeft(m.host);
      m.page.setReduced(true);
      assert.equal(windowLeft(m.host), left, 'the window stops where it was');
      m.page.run(10_000);
      assert.equal(states.length, n, 'no further scene');
      assert.equal(windowLeft(m.host), left);
      assert.equal(m.page.frames.size, 0, 'nothing moves');
      byLabel(m.host, 'Play');
      m.page.view(0); m.page.view(0.9);
      m.page.run(10_000);
      assert.equal(states.length, n, 'coming back into view does not restart it');
    } finally { m.handle.destroy(); m.page.uninstall(); }
  }
  {
    // Paused for the view when reduced motion comes on: back in view, it stays paused.
    const m = mounted();
    try {
      const states: DemoLevels[] = [];
      m.store().subscribe(s => states.push(s));
      m.page.view(0.6);
      m.page.run(500);
      m.page.view(0.1);
      m.page.setReduced(true);
      m.page.view(0.8);
      m.page.run(20_000);
      assert.equal(states.length, 1, 'only the first scene');
    } finally { m.handle.destroy(); m.page.uninstall(); }
  }
  {
    // Started by the person (Play after their own Pause): it goes on, its motions instant from then on.
    const m = mounted();
    try {
      const states: DemoLevels[] = [];
      m.store().subscribe(s => states.push(s));
      m.page.view(0.6);
      m.page.run(500);
      byLabel(m.host, 'Pause').fire('click');
      byLabel(m.host, 'Play').fire('click');
      m.page.setReduced(true);
      m.page.run(9000);
      assert.ok(states.length >= 3, `the tour goes on (${states.length} scenes)`);
      m.page.view(0.1); m.page.view(0.8);
      m.page.run(30_000);
      assert.equal(states.length, 8, 'back in view it goes on to its end');
    } finally { m.handle.destroy(); m.page.uninstall(); }
  }
});

test('mounted: destroy() stops every frame, timer, observer and listener, and takes the demo away; pause() holds it', () => {
  demoData();
  for (const builtIn of [false, true]) {
    const page = new FakePage();
    page.install();
    try {
      const host = new FakeElement('div', page);
      let destroyed = 0;
      const handle = builtIn ? mountDemo(host as unknown as HTMLElement) : mountDemo(host as unknown as HTMLElement, { control: () => ({ destroy() { destroyed++; } }) });
      page.view(0.7);
      page.run(1500);
      if (builtIn) {
        // The built-in control's note for the last kind on keeps a timer: destroy must clear it too.
        const rows = host.all().filter(e => e.getAttribute('role') === 'switch');
        assert.equal(rows.length, 3);
        rows[0]!.fire('click'); rows[1]!.fire('click'); rows[2]!.fire('click');
        assert.equal(page.timers.size, 1, 'the note is up');
      }
      assert.ok(page.frames.size > 0, 'frames while things move');
      assert.equal(page.resizes.size, 1); assert.equal(page.views.size, 1); assert.equal(page.listenerCount(), 2, 'the visibility of the tab and the reduced-motion query');
      page.view(0);
      handle.pause();
      page.view(0.9);
      const caption = byClass(host, 'pd-caption'), before = caption.textContent;
      page.run(15_000);
      assert.equal(caption.textContent, before, 'paused by the page: coming back into view does not resume it');
      assert.equal(page.frames.size, 0, 'and nothing runs while it is paused');
      handle.destroy();
      assert.equal(page.frames.size, 0, 'no frame');
      assert.equal(page.timers.size, 0, 'no timer');
      assert.equal(page.idles.size, 0, 'no idle callback');
      assert.equal(page.resizes.size, 0, 'no resize observer');
      assert.equal(page.views.size, 0, 'no view observer');
      assert.equal(page.listenerCount(), 0, 'no listener on the document or the reduced-motion query');
      assert.equal(host.children.length, 0, 'nothing left in the host');
      if (!builtIn) assert.equal(destroyed, 1, 'the control passed in is destroyed with it');
      handle.destroy();
      assert.deepEqual(page.network, [], 'and nothing asked of the network');
    } finally { page.uninstall(); }
  }
});

test('mounted: the built-in control keeps one kind on and says so; its note goes with a timer that destroy() clears', () => {
  demoData();
  const page = new FakePage();
  page.install();
  try {
    const host = new FakeElement('div', page);
    const handle = mountDemo(host as unknown as HTMLElement);
    const rows = host.all().filter(e => e.getAttribute('role') === 'switch');
    assert.deepEqual(rows.map(r => r.getAttribute('aria-checked')), ['true', 'true', 'true']);
    rows[0]!.fire('click'); rows[1]!.fire('click');
    assert.deepEqual(rows.map(r => r.getAttribute('aria-checked')), ['false', 'false', 'true']);
    assert.equal(rows[2]!.getAttribute('aria-disabled'), 'true', 'the last kind on cannot be switched off');
    rows[2]!.fire('click');
    assert.equal(rows[2]!.getAttribute('aria-checked'), 'true');
    const note = byClass(host, 'pd-lv-note');
    assert.equal(note.textContent, 'One kind stays on.');
    assert.equal(page.timers.size, 1);
    const radios = host.all().filter(e => e.getAttribute('role') === 'radio');
    radios[1]!.fire('click');
    assert.deepEqual(radios.map(r => r.getAttribute('aria-checked')), ['false', 'true']);
    radios[1]!.fire('keydown', { key: 'Home' });
    assert.deepEqual(radios.map(r => r.getAttribute('aria-checked')), ['true', 'false']);
    handle.destroy();
    assert.equal(page.timers.size, 0, 'the note\'s timer is cleared');
  } finally { page.uninstall(); }
});

test('mounted: the chart stays within about 300 SVG elements and is 320 px tall on a phone, 372 on a wider screen', () => {
  for (const [width, height] of [[700, 372], [360, 320], [1200, 372]] as const) {
    const m = mounted({ width });
    try {
      m.page.run(200);
      const svg = byClass(m.host, 'pd-ch');
      const count = 1 + svg.all().length;
      assert.ok(count > 60 && count <= 300, `${width} px: ${count} elements`);
      const box = byClass(m.host, 'pd-chart');
      assert.equal(box.style.height, `${height}px`);
      assert.equal(svg.getAttribute('height'), String(height));
    } finally { m.handle.destroy(); m.page.uninstall(); }
  }
});

test('the feature pictures: three still pictures, each labelled as illustrative, taken away by destroy()', () => {
  demoData();
  const page = new FakePage();
  page.install();
  try {
    const hosts = { history: new FakeElement('div', page), layers: new FakeElement('div', page), groups: new FakeElement('div', page) };
    const v = mountVisuals(hosts as unknown as { history: HTMLElement; layers: HTMLElement; groups: HTMLElement });
    for (const [name, h] of Object.entries(hosts)) {
      const svg = h.all().find(e => e.tagName === 'svg')!;
      assert.ok(svg, `${name}: a picture`);
      assert.ok(svg.all().length < 120, `${name}: ${svg.all().length} elements`);
      assert.equal(byClass(h, 'pd-vis-tag').textContent, 'Illustrative data');
    }
    assert.equal(page.frames.size + page.timers.size + page.resizes.size + page.views.size, 0, 'nothing timed or watched');
    v.destroy();
    for (const h of Object.values(hosts)) assert.equal(h.children.length, 0);
    assert.deepEqual(page.network, []);
  } finally { page.uninstall(); }
});

/**
 * A fake page for a test that builds the numbers cold. What the body leaves behind (the mounts it tracked, a build under way) is taken down
 * while the page's globals are still installed, and only then are they removed: an assertion that fails in the middle of a build is the
 * error the test reports, not a teardown that reaches for a `window` already gone. The numbers are warm again for the tests after.
 */
function coldPage(body: (page: FakePage, track: <T extends { destroy(): void }>(handle: T) => T) => void, page = new FakePage()): void {
  const handles: { destroy(): void }[] = [];
  page.install();
  try {
    body(page, handle => { handles.push(handle); return handle; });
  } finally {
    for (const handle of handles) handle.destroy();
    forgetData();
    page.uninstall();
    demoData();
  }
}

test('a cold test that fails while the numbers are being built reports its own failure, not its teardown', () => {
  const page = new FakePage();
  assert.throws(() => coldPage((p, track) => {
    forgetData();
    track(mountDemo(new FakeElement('div', p) as unknown as HTMLElement));
    assert.equal(p.idles.size, 1, 'a build under way');
    assert.fail('the body failed in the middle of the build');
  }, page), (error: unknown) => error instanceof assert.AssertionError && /the body failed in the middle of the build/.test(error.message));
  assert.equal(page.idles.size, 0, 'the build was stopped before the page went');
  assert.equal(typeof (globalThis as Record<string, unknown>).window, 'undefined', 'and the page is gone');
  assert.ok(demoData(), 'the numbers are warm again');
});

test('cold: the demo paints its frame first and builds the numbers in idle turns; warm mounts have them at once; destroy() stops the build', () => {
  const same = (a: DemoData, b: DemoData): boolean => (['price', 'liqL', 'liqS', 'stopL', 'stopS', 'tpL', 'tpS', 'pfLiq', 'pfStop', 'pfTp', 'band'] as const).every(k => Buffer.from(a[k].buffer).equals(Buffer.from(b[k].buffer)));
  const reference = createData(SEED);
  forgetData();
  coldPage((page, track) => {
    // A cold mount: the frame, the controls and the scrubber at once, the chart's room kept, nothing drawn and nothing played yet.
    const host = new FakeElement('div', page);
    const states: DemoLevels[] = [];
    const handle = track(mountDemo(host as unknown as HTMLElement, { control: (_h, st) => { st.subscribe(x => states.push(x)); return { destroy() {} }; } }));
    const stage = byClass(host, 'pd-stage'), svg = byClass(host, 'pd-ch');
    assert.equal(stage.getAttribute('aria-busy'), 'true', 'the stage says it is getting ready');
    assert.equal(svg.children.length, 0, 'the chart waits for the numbers');
    assert.equal(byClass(host, 'pd-chart').style.height, '372px', 'its room is kept');
    byLabel(host, 'History'); byClass(host, 'pd-legend');
    assert.equal(page.idles.size, 1, 'the build waits for the page to be idle');
    page.view(0.9);
    page.run(2000);
    assert.equal(states.length, 0, 'the autoplay waits for the numbers too');
    // A destroy in the middle of the build stops it; the steps done are kept for the next mount.
    assert.equal(page.idle(3), 3);
    handle.destroy();
    assert.equal(page.idles.size + page.timers.size + page.frames.size, 0, 'destroy() stops the build with everything else');
    // A second cold mount picks the build up and finishes it in further turns: then the chart is drawn and the tour plays.
    const host2 = new FakeElement('div', page);
    const states2: DemoLevels[] = [];
    const handle2 = track(mountDemo(host2 as unknown as HTMLElement, { control: (_h, st) => { st.subscribe(x => states2.push(x)); return { destroy() {} }; } }));
    assert.ok(page.idle() > 0);
    assert.ok(same(demoData(), reference), 'built in turns, the same numbers as all at once');
    assert.equal(byClass(host2, 'pd-stage').getAttribute('aria-busy'), null, 'ready');
    page.view(0.9);
    page.run(500);
    assert.ok(byClass(host2, 'pd-ch').all().length > 60, 'the chart is drawn');
    assert.equal(states2.length, 1, 'and the tour plays');
    handle2.destroy();
    // A warm mount: drawn in its first frame, nothing left to build.
    const host3 = new FakeElement('div', page);
    const handle3 = track(mountDemo(host3 as unknown as HTMLElement));
    page.run(20);
    assert.equal(page.idles.size, 0, 'nothing to build');
    assert.ok(byClass(host3, 'pd-ch').all().length > 60, 'drawn at once');
    handle3.destroy();
    // The pictures: frames at once (their room kept by their size), drawn when the numbers are here.
    forgetData();
    const hosts = { history: new FakeElement('div', page), layers: new FakeElement('div', page), groups: new FakeElement('div', page) };
    const v = track(mountVisuals(hosts as unknown as { history: HTMLElement; layers: HTMLElement; groups: HTMLElement }));
    for (const h of Object.values(hosts)) {
      const pic = byClass(h, 'pd-vis');
      assert.equal(pic.children.length, 0, 'a frame, not yet drawn');
      assert.ok(pic.getAttribute('viewBox'), 'its size keeps its room');
      assert.equal(byClass(h, 'pd-vis-tag').textContent, 'Illustrative data');
    }
    page.idle();
    for (const h of Object.values(hosts)) assert.ok(byClass(h, 'pd-vis').children.length > 5, 'drawn');
    v.destroy();
    // whenData: at once when the numbers are built, and nothing left to stop.
    let got: DemoData | null = null;
    whenData(d => { got = d; })();
    assert.equal(got, demoData());
    assert.equal(page.idles.size, 0);
    assert.deepEqual(page.network, []);
  });
});

test('the scenes keep targets of 44 px at every width: six in a row while 294 px hold them, then two rows of three', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'plus', 'demo', 'demo.css'), 'utf8');
  // The row: six columns and their gap, in the stylesheet's own numbers.
  const row = /\n\.pd-scenes \{[^}]*grid-template-columns: repeat\((\d+), minmax\(0, 1fr\)\);[^}]*gap: (\d+)px;/.exec(css);
  assert.ok(row, 'the scenes row');
  const columns = Number(row[1]), gap = Number(row[2]);
  // A phone's target, and the scene buttons sized by it.
  const phone = /@container pd \(max-width: 600px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  const target = Number(/--pd-target: (\d+)px/.exec(phone)?.[1]);
  assert.equal(target, 44);
  assert.match(css, /\.pd button\.pd-scene \{[^}]*min-height: var\(--pd-target\)/, 'a scene is as tall as the target');
  // The narrow rule: where six no longer fit, three to a row.
  const narrow = /@container pd \(width < (\d+)px\) \{\s*\.pd-scenes \{ grid-template-columns: repeat\((\d+), minmax\(0, 1fr\)\); \}/.exec(css);
  assert.ok(narrow, 'a rule for narrow containers');
  const below = Number(narrow[1]), fewer = Number(narrow[2]);
  assert.equal(below, columns * target + (columns - 1) * gap, 'it starts exactly where six targets and their gaps stop fitting');
  const width = (n: number, room: number): number => (room - (n - 1) * gap) / n;
  assert.ok(width(columns, below) >= target && width(columns, below - 1) < target);
  for (const room of [288, 260, 240]) assert.ok(width(fewer, room) >= target, `${room} px: ${width(fewer, room).toFixed(1)} px a scene`);
  assert.ok(Math.ceil(6 / fewer) <= 2, 'and at most two rows');
});

test('the Depth strip\'s dates: three where there is room; on a narrow strip the first only where it fits beside the last', () => {
  const datesOf = (host: FakeElement): string[] => {
    const svg = byClass(host, 'pd-ch'), y = svg.all().find(e => e.tagName === 'text' && e.getAttribute('text-anchor') === 'middle')!.getAttribute('y');
    return svg.all().filter(e => e.tagName === 'text' && e.getAttribute('y') === y && e.style.display !== 'none').map(e => e.textContent);
  };
  // A desktop's strip holds three; a 320 px phone's two, or only the last where the words are long (40 px a date, as "Maintenant" is).
  for (const [width, long, expected] of [[700, false, 3], [288, false, 2], [288, true, 1]] as const) {
    const m = mounted({ width, ...(long ? { textWidth: () => 40 } : {}) });
    try {
      m.page.run(50);
      const dates = datesOf(m.host);
      assert.equal(dates.length, expected, `${width} px${long ? ', long words' : ''}: ${dates.join(' | ')}`);
      assert.equal(dates.at(-1), 'Now', 'the end of the window is always said');
    } finally { m.handle.destroy(); m.page.uninstall(); }
  }
});

test('cold: Play or Play again pressed while the numbers are built shows Pause, waits, and starts the tour at its first scene when they arrive', () => {
  coldPage((page, track) => {
    for (const button of ['Play', 'Play again'] as const) {
      for (const then of ['arrive', 'Pause', 'destroy'] as const) {
        forgetData();
        const host = new FakeElement('div', page);
        const states: DemoLevels[] = [];
        const handle = track(mountDemo(host as unknown as HTMLElement, { control: (_h, st) => { st.subscribe(x => states.push(x)); return { destroy() {} }; } }));
        const label = `${button}, then ${then}`;
        page.view(0.9);
        byLabel(host, button).fire('click');
        assert.equal(byClass(host, 'pd-play').all().find(e => e.tagName === 'button')!.getAttribute('aria-label'), 'Pause', `${label}: the button shows Pause at once`);
        page.run(3000);
        assert.equal(states.length, 0, `${label}: no scene goes by over the empty stage`);
        assert.equal(byClass(host, 'pd-caption').textContent, 'Try the switches.', `${label}: still the invitation`);
        if (then === 'Pause') byLabel(host, 'Pause').fire('click');
        if (then === 'destroy') handle.destroy();
        page.idle();
        page.run(500);
        if (then === 'arrive') {
          assert.deepEqual(states.map(x => [+x.liq, +x.stops, +x.takes]), [[1, 0, 0]], `${label}: the tour starts at its first scene`);
          assert.equal(byClass(host, 'pd-caption').textContent, 'Liquidation levels at each price.');
          page.run(4000);
          assert.deepEqual(states.map(x => [+x.liq, +x.stops, +x.takes]), [[1, 0, 0], [1, 1, 0]], `${label}: and goes on from there`);
        } else {
          assert.equal(states.length, 0, `${label}: cancelled, nothing plays when the numbers arrive`);
          if (then === 'Pause') assert.ok(byLabel(host, 'Play'), `${label}: the button shows Play`);
        }
        handle.destroy();
        assert.equal(page.idles.size + page.timers.size + page.frames.size, 0, `${label}: nothing left behind`);
      }
    }
  });
});

test('cold: when the numbers arrive, a waiter that an earlier one stopped is not called (a mount destroyed by the first one stays quiet)', () => {
  coldPage((page, track) => {
    // whenData itself: the first waiter's call stops the second; the second is never called, and a third still is.
    forgetData();
    const called: string[] = [];
    let stopSecond: () => void = () => {};
    whenData(() => { called.push('first'); stopSecond(); });
    stopSecond = whenData(() => { called.push('second'); });
    whenData(() => { called.push('third'); });
    page.idle();
    assert.deepEqual(called, ['first', 'third']);
    // Two cold demos in view: the first one's autoplay changes its store, and that destroys the second, which waits too.
    forgetData();
    const hostA = new FakeElement('div', page), hostB = new FakeElement('div', page);
    const statesB: DemoLevels[] = [];
    let handleB: { destroy(): void } | null = null;
    const handleA = track(mountDemo(hostA as unknown as HTMLElement, { control: (_h, st) => { const stop = st.subscribe(() => { handleB?.destroy(); stop(); }); return { destroy() { stop(); } }; } }));
    handleB = track(mountDemo(hostB as unknown as HTMLElement, { control: (_h, st) => { st.subscribe(x => statesB.push(x)); return { destroy() {} }; } }));
    page.view(0.9);
    page.idle();
    page.run(5000);
    assert.equal(hostB.children.length, 0, 'the second demo was taken away');
    assert.deepEqual(statesB, [], 'and nothing of it ran after: no tour, no store change');
    handleA.destroy();
    assert.equal(page.idles.size + page.timers.size + page.frames.size, 0, 'nothing left behind');
    // The pictures the same: destroyed by an earlier waiter, they draw nothing.
    forgetData();
    const hosts = { history: new FakeElement('div', page), layers: new FakeElement('div', page), groups: new FakeElement('div', page) };
    let v: { destroy(): void } | null = null;
    let drawnAfter = -1;
    whenData(() => { const svg = byClass(hosts.history, 'pd-vis'); v?.destroy(); drawnAfter = svg.children.length; });
    v = track(mountVisuals(hosts as unknown as { history: HTMLElement; layers: HTMLElement; groups: HTMLElement }));
    const svg = byClass(hosts.history, 'pd-vis');
    page.idle();
    assert.equal(drawnAfter, 0);
    assert.equal(svg.children.length, 0, 'the pictures taken away before their turn draw nothing');
  });
});

test('cold: a waiter that throws when the numbers arrive does not keep them from the others, and its error is still thrown after', () => {
  coldPage((page, track) => {
    // whenData itself: the first throws, the second is still called, and the error comes out afterwards as it was.
    forgetData();
    const called: string[] = [];
    whenData(() => { called.push('first'); throw new Error('first waiter failed'); });
    whenData(() => { called.push('second'); });
    page.idle();
    assert.deepEqual(called, ['first', 'second']);
    assert.deepEqual(page.microtasks().map(e => (e as Error).message), ['first waiter failed'], 'thrown again after the hand-out');
    // Several that throw: every error comes out, each on its own, in the order of the waiters; the one between them is still called.
    forgetData();
    const order: string[] = [];
    whenData(() => { order.push('A'); throw new Error('A failed'); });
    whenData(() => { order.push('B'); });
    whenData(() => { order.push('C'); throw new Error('C failed'); });
    page.idle();
    assert.deepEqual(order, ['A', 'B', 'C']);
    assert.deepEqual(page.microtasks().map(e => (e as Error).message), ['A failed', 'C failed'], 'both, in order');
    // A waiter that joins during the hand-out (asked for by a waiter's own call) is given the numbers at once, once, with nothing left to build.
    forgetData();
    const joined: DemoData[] = [];
    let first: DemoData | null = null;
    whenData(d => { first = d; whenData(e => joined.push(e)); });
    page.idle();
    assert.ok(first);
    assert.deepEqual(joined, [first], 'called once, at once, with the same numbers');
    assert.equal(page.idles.size, 0);
    // Two cold demos: Play queued on the first, whose control's store listener throws in the first scene; the second still gets the numbers.
    forgetData();
    const hostA = new FakeElement('div', page), hostB = new FakeElement('div', page);
    track(mountDemo(hostA as unknown as HTMLElement, { control: (_h, st) => { st.subscribe(() => { throw new Error('the listener failed'); }); return { destroy() {} }; } }));
    track(mountDemo(hostB as unknown as HTMLElement));
    page.view(0.9);
    byLabel(hostA, 'Play').fire('click');
    page.idle();
    page.run(50);
    for (const [name, host] of [['the second', hostB], ['the first', hostA]] as const) {
      assert.equal(byClass(host, 'pd-stage').getAttribute('aria-busy'), null, `${name} demo is ready`);
      assert.ok(byClass(host, 'pd-ch').all().length > 60, `${name} demo's chart is drawn`);
    }
    assert.equal(page.idles.size, 0, 'and no build is left waiting');
    assert.deepEqual(page.microtasks().map(e => (e as Error).message), ['the listener failed'], 'the error is not swallowed');
  });
});

/** Everything the chart shows, as text: each element's shape and how strongly it is drawn. Two equal pictures are the same drawing. */
const chartPicture = (host: FakeElement): string => byClass(host, 'pd-ch').all()
  .map(e => `${e.tagName}|${e.getAttribute('d') ?? ''}|${e.style.opacity ?? ''}|${e.style.display ?? ''}|${e.textContent.length < 40 ? e.textContent : ''}`).join('\n');

test('cold: Play pressed while loading, then the tab hidden or the demo under 45 % in view: the queued tour starts held, its chart still and no frame asked for', () => {
  coldPage((page, track) => {
    for (const away of ['under 45 % in view', 'tab hidden'] as const) {
      forgetData();
      const host = new FakeElement('div', page);
      const states: DemoLevels[] = [];
      const handle = track(mountDemo(host as unknown as HTMLElement, { control: (_h, st) => { st.subscribe(x => states.push(x)); return { destroy() {} }; } }));
      page.view(0.9);
      byLabel(host, 'Play').fire('click');
      if (away === 'tab hidden') page.setHidden(true); else page.view(0.4);
      page.idle();
      page.run(16);
      assert.deepEqual(states.map(x => [+x.liq, +x.stops, +x.takes]), [[1, 0, 0]], `${away}: the tour started at its first scene`);
      const held = chartPicture(host);
      assert.ok(held.split('\n').length > 60, `${away}: the chart is drawn`);
      page.run(48);
      assert.equal(page.frames.size, 0, `${away}: no frame is asked for while it is held (its first move, 220 ms long, would still be asking)`);
      page.run(1000);
      assert.equal(page.frames.size, 0, `${away}: nor later`);
      assert.equal(chartPicture(host), held, `${away}: the chart holds still (its first move waits too)`);
      assert.equal(states.length, 1, `${away}: no further scene`);
      // Back in view: the tour goes on, its first move with it.
      if (away === 'tab hidden') page.setHidden(false); else page.view(0.9);
      page.run(300);
      assert.notEqual(chartPicture(host), held, `${away}: back in view, the chart moves on`);
      page.run(4000);
      assert.equal(states.length, 2, `${away}: and the tour goes on to its next scene`);
      handle.destroy();
    }
  });
});

test('cold: Play queued, the demo at 40 % in view, and a store listener that throws once in the first scene: the tour is still held for the view', () => {
  coldPage((page, track) => {
    forgetData();
    const host = new FakeElement('div', page);
    const states: DemoLevels[] = [];
    let threw = false;
    track(mountDemo(host as unknown as HTMLElement, { control: (_h, st) => {
      st.subscribe(x => { states.push(x); if (!threw) { threw = true; throw new Error('the listener failed once'); } });
      return { destroy() {} };
    } }));
    page.view(0.9);
    byLabel(host, 'Play').fire('click');
    page.view(0.4);
    page.idle();
    assert.deepEqual(page.microtasks().map(e => (e as Error).message), ['the listener failed once'], 'the error is reported, not swallowed');
    page.run(16);
    assert.deepEqual(states.map(x => [+x.liq, +x.stops, +x.takes]), [[1, 0, 0]], 'the tour started at its first scene');
    const held = chartPicture(host);
    page.run(48);
    assert.equal(page.frames.size, 0, 'no frame is asked for while it is held for the view');
    page.run(10_000);
    assert.equal(chartPicture(host), held, 'the chart holds still');
    assert.equal(states.length, 1, 'and no scene goes by under 45 % in view');
    assert.equal(byLabel(host, 'Play').getAttribute('aria-label'), 'Play', 'the button says it is paused');
    page.view(0.9);
    page.run(300);
    assert.notEqual(chartPicture(host), held, 'back in view, the chart moves on');
    page.run(4000);
    assert.equal(states.length, 2, 'and the tour goes on to its next scene');
  });
});

test('an error thrown after a hand-out that no test read fails the test that left it; one read on purpose does not', () => {
  // Left unread: the page runs it when it goes and keeps the error for the check after the test (taken here, so this test can pass).
  const page = new FakePage();
  page.install();
  queueMicrotask(() => { throw new Error('left unread'); });
  page.uninstall();
  assert.deepEqual(leftOver.splice(0).map(e => (e as Error).message), ['left unread']);
  assert.equal(typeof (globalThis as Record<string, unknown>).window, 'undefined', 'the page is gone all the same');
  // Read on purpose: nothing is left for the check.
  page.install();
  queueMicrotask(() => { throw new Error('read'); });
  assert.deepEqual(page.microtasks().map(e => (e as Error).message), ['read']);
  page.uninstall();
  assert.deepEqual(leftOver, []);
  // The case it is for: a waiter that changes what a test looks at and then throws. The test's own checks pass, and the error does not vanish.
  let ready = false;
  coldPage(p => {
    forgetData();
    whenData(() => { ready = true; throw new Error('thrown after the change'); });
    p.idle();
    assert.equal(ready, true);
  });
  assert.deepEqual(leftOver.splice(0).map(e => (e as Error).message), ['thrown after the change'], 'kept: the check after the test would fail it');
});

test('the page runs, when it goes, what its queued tasks queue in turn: an error two tasks deep is not lost', () => {
  const page = new FakePage();
  page.install();
  // A build under way with a waiter that throws, and a queued task that finishes the build (demoData), which queues the waiter's error.
  forgetData();
  whenData(() => { throw new Error('the waiter failed two tasks deep'); });
  queueMicrotask(() => { demoData(); });
  page.uninstall();
  assert.deepEqual(leftOver.splice(0).map(e => (e as Error).message), ['the waiter failed two tasks deep'], 'kept for the check after the test');
  // Read on purpose, the same: microtasks() runs the tasks queued by tasks too.
  page.install();
  queueMicrotask(() => { queueMicrotask(() => { throw new Error('queued by a queued task'); }); });
  assert.deepEqual(page.microtasks().map(e => (e as Error).message), ['queued by a queued task']);
  page.uninstall();
  assert.deepEqual(leftOver, []);
});

test('cold: a demo that its own listener destroys (and throws) in the queued first scene does nothing more, and the error is reported', () => {
  coldPage((page, track) => {
    forgetData();
    const host = new FakeElement('div', page);
    const states: DemoLevels[] = [];
    let handle: { destroy(): void } | null = null;
    handle = track(mountDemo(host as unknown as HTMLElement, { control: (_h, st) => {
      st.subscribe(x => { states.push(x); handle?.destroy(); throw new Error('destroyed by its own listener'); });
      return { destroy() {} };
    } }));
    page.view(0.9);
    byLabel(host, 'Play').fire('click');
    page.idle();
    assert.deepEqual(page.microtasks().map(e => (e as Error).message), ['destroyed by its own listener']);
    assert.equal(host.children.length, 0, 'the demo is gone');
    page.run(5000);
    assert.equal(states.length, 1, 'and nothing of it ran after');
    assert.equal(page.frames.size + page.idles.size + page.timers.size + page.resizes.size + page.views.size + page.listenerCount(), 0, 'nothing left behind');
  });
});

/* ==== no network, no app settings ======================================================================================================= */

test('the module asks nothing of the network and touches none of the app\'s settings: its files and what they import', () => {
  const dir = path.join(process.cwd(), 'src', 'app', 'plus', 'demo');
  const files = fs.readdirSync(dir).filter(f => /\.(ts|css)$/.test(f));
  assert.ok(files.includes('demo.ts') && files.includes('demo.css') && files.includes('data.ts'));
  const allowed = new Set(['../../i18n.ts', '../../format.ts', '../name.ts', './demo.css']);
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const code = text.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '');
    for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /\bimport\s*\(/, /new Image\b/, /importScripts/, /https?:\/\//, /localStorage/, /sessionStorage/, /indexedDB/, /@import/, /url\(\s*['"]?(?!data:)/]) {
      assert.ok(!banned.test(code), `${file}: ${banned}`);
    }
    for (const m of text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
      const spec = m[1]!;
      assert.ok(allowed.has(spec) || /^\.\/[\w-]+\.ts$/.test(spec), `${file} imports ${spec}`);
    }
  }
  // What it borrows from the app imports nothing more.
  for (const borrowed of ['src/app/i18n.ts', 'src/app/format.ts', 'src/app/plus/name.ts']) {
    const imports = [...fs.readFileSync(borrowed, 'utf8').matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]);
    assert.ok(imports.every(s => s === './i18n.ts'), `${borrowed}: ${imports.join(', ')}`);
  }
});
