import type { Expr, Stmt } from './parser.ts';
import { ScriptSyntaxError, type ScriptError } from './lexer.ts';
import { Interpreter, charge, type Budget, type Host } from './interpreter.ts';
import { declaredNames, numberSites } from './walk.ts';
import { DEPTH_FUNCTIONS, FULL_RUN_MS, MAX_PLOTS, PLOTS, RUN_MS, STEPS_PER_CANDLE, analyze, literal, optionTable, sourceFilter, type Analysis } from './analysis.ts';
import { DateValue, HostObject, NativeFunction, ScriptRuntimeError, isPlain, num, own, plain, text, toData, truthy, type Value } from './values.ts';
import { BUILTINS, MAX_WINDOW, makeInstance, type Candle, type Instance } from './builtins.ts';
import { COLOR_NAMES, interpolateColors, rgb, safeColor } from './colors.ts';
import { ALERT_SOUNDS, ALERT_TEXT, MARK_TEXT, MARK_TIP, MAX_ALERTS, PLOT_FIELDS, type AlertOut, type AlertSound, type PlotKind, type PlotOut, type ScriptResult } from '../protocol.ts';
import { DEFAULT_SCRIPT_THEME, filterKey, type BarInputs, type SourceFilter, type SourceInputs } from '../inputs.ts';
import type { OptionValue } from '../records.ts';

/**
 * A script from text to plots. `analyze` reads it without running it (what it declares, which sets of markets it reads), so the page can
 * gather the inputs before a run; `runScript` runs it over every candle, oldest first, one pass of the interpreter per candle.
 *
 * The language (version 1): JavaScript's expressions and statements as `parser.ts` reads them, with these names:
 * - inputs of the candle: `time` (its start, seconds), `vbuy`, `vsell` (USD bought and sold at market over the markets read), `lbuy`, `lsell`
 *   (USD of shorts and longs liquidated), `oichg` (USD of open interest opened or closed, over the OI pane's venues), `cbuy`, `csell` (trade
 *   counts: not recorded, always NaN), `bar` (all of those, and `timestamp`),
 *   `$price` (the chart's candle: `open`, `high`, `low`, `close`, `volume`; setting `$price.color` colours it), `renderer.length` (candles so
 *   far), `renderer.forming` (whether this is the candle under way);
 * - `options.name` and `name = option(default = ..., type = ..., label = ..., min, max, step)`: the script's settings;
 * - `source(expr, type = spot|perp, exchange = NAME, quote = USDT)`: `expr` read over those markets only;
 * - a name assigned at the top without `var`/`let`/`const` keeps its value from candle to candle, and `name[1]` is its value one candle back;
 * - the functions of `builtins.ts` (`sma`, `ema`, `cum`, ...), each call keeping its own state, and the plots (`line`, `histogram`, `mark`, ...);
 * - `alert(text, sound=..., when=bar|close)`: an alert at the candle under way or the last one closed (older candles are history).
 * A candle that was not recorded reads NaN, and a function given NaN answers NaN and keeps its state, so a line starts where the data does.
 */

/**
 * A plot's named argument as it can be read before the script runs: a literal, an option (`options.up`, or a declared option's name), an object
 * of those (`scaleMargins={top: 0.1}`), or a plain word that names nothing in the script (`title=PERP`). Undefined for anything the script
 * works out (it is read when the plot first runs).
 */
function staticValue(e: Expr, opt: Readonly<Record<string, Value>>, scriptNames: ReadonlySet<string>): OptionValue | undefined {
  if (e.k === 'member' && e.obj.k === 'id' && e.obj.name === 'options') return toData(opt[e.name]);
  if (e.k === 'id') {
    if (Object.prototype.hasOwnProperty.call(opt, e.name)) return toData(opt[e.name]);
    if (scriptNames.has(e.name) || scriptNames.has(e.name.toLowerCase())) return undefined;
  }
  if (e.k === 'obj') {
    const o: Record<string, OptionValue> = {};
    for (const p of e.props) { const v = staticValue(p.value, opt, scriptNames); if (v === undefined) return undefined; o[p.key] = v; }
    return o;
  }
  return literal(e);
}

/** The longest title a plot keeps, and the longest text of its style. */
const MAX_TITLE = 120, MAX_STYLE_TEXT = 200;
/**
 * Where the stateful functions that count back over a window of candles take its length: a run whose longest window is longer than the
 * candles it was given is warned of (`long-window`), since such a window never fills and holds only the candles there are, and so is one
 * that asked a window longer than any can be (`MAX_WINDOW`, the length it then has).
 */
const WINDOW_ARG: Readonly<Record<string, number>> = Object.assign(Object.create(null) as Record<string, number>, { sum: 1, sma: 1, cma: 1, highest: 1, lowest: 1, linreg: 1, last: 1, stoch: 3 });
/** A plot's style value held to short texts (a title or a colour, never a long text the page would have to carry). */
function styleData(v: OptionValue | undefined): OptionValue | undefined {
  if (typeof v === 'string') return v.length <= MAX_STYLE_TEXT ? v : undefined;
  if (Array.isArray(v)) return v.slice(0, 16).map(x => styleData(x) ?? null);
  if (v && typeof v === 'object') { const out: Record<string, OptionValue> = {}; for (const [k, x] of Object.entries(v).slice(0, 32)) { const d = styleData(x); if (d !== undefined) out[k] = d; } return out; }
  return v;
}

/** What a run of a script keeps per plot while it goes from candle to candle. */
interface PlotBuild { kind: PlotKind; title: string; style: Record<string, OptionValue>; fields: Record<string, Float64Array>; colors: string[] | null; texts: string[] | null; tips: string[] | null }

/**
 * Run a script over every candle of `inputs`. `optionValues` are the values set for its options (a declared option not set reads its default).
 * Returns what to draw, or the first error with where it happened.
 */
export function runScript(id: string, source: string, optionValues: Record<string, OptionValue>, inputs: BarInputs, now: () => number = Date.now): ScriptResult {
  return createRunner(id, source, optionValues, now).run(inputs);
}

/** A script read once and run as often as its inputs change. */
export interface ScriptRunner {
  run(inputs: BarInputs): ScriptResult;
  /** The candle the last run started from: 0 for a run over every candle, more when only the candles after the last closed one ran again. */
  readonly startedAt: number;
}

const NO_INPUTS: BarInputs = { tf: 60_000, time: new Float64Array(0), open: new Float64Array(0), high: new Float64Array(0), low: new Float64Array(0), close: new Float64Array(0), volume: new Float64Array(0), sources: {}, forming: false };

/** Whether candles [0, m) of two inputs are the same (NaN where both are NaN): the only candles a run may take over from the one before. */
export function sameCandles(a: BarInputs, b: BarInputs, m: number): boolean {
  if (a.tf !== b.tf || m > a.time.length || m > b.time.length) return false;
  const ta = a.theme ?? DEFAULT_SCRIPT_THEME, tb = b.theme ?? DEFAULT_SCRIPT_THEME;
  if (ta.dark !== tb.dark || ta.background !== tb.background || ta.text !== tb.text || ta.up !== tb.up || ta.down !== tb.down) return false;
  const ka = Object.keys(a.sources), kb = Object.keys(b.sources);
  if (ka.length !== kb.length || ka.some(k => !(k in b.sources))) return false;
  const eq = (x: Float64Array, y: Float64Array): boolean => { for (let k = 0; k < m; k++) { const u = x[k]!, v = y[k]!; if (u !== v && !(u !== u && v !== v)) return false; } return true; };
  if (!eq(a.time, b.time) || !eq(a.open, b.open) || !eq(a.high, b.high) || !eq(a.low, b.low) || !eq(a.close, b.close) || !eq(a.volume, b.volume)) return false;
  if (!a.oichg !== !b.oichg || (a.oichg && b.oichg && !eq(a.oichg, b.oichg))) return false;
  for (const k of ka) {
    const x = a.sources[k]!, y = b.sources[k]!;
    if (!eq(x.vbuy, y.vbuy) || !eq(x.vsell, y.vsell) || !eq(x.lbuy, y.lbuy) || !eq(x.lsell, y.lsell)) return false;
    if (!x.recorded !== !y.recorded || (x.recorded && y.recorded && !eq(x.recorded, y.recorded))) return false;
  }
  return true;
}

/** Whether the first `m` candles' order book is the same in both (each candle's depth revision; neither holding any is the same). */
export function sameDepth(a: BarInputs, b: BarInputs, m: number): boolean {
  const x = a.depthEpochs, y = b.depthEpochs;
  if (!x || !y) return !x && !y;
  if (m > x.length || m > y.length) return false;
  for (let k = 0; k < m; k++) if (x[k] !== y[k]) return false;
  return true;
}

/** A copy of a script value deep enough that a later run cannot change it: the script's own arrays and objects copied, the rest shared (they do not change). */
function cloneValue(v: Value, seen = new Map<object, Value>()): Value {
  if (v === null || typeof v !== 'object') return v;
  const had = seen.get(v); if (had !== undefined) return had;
  if (Array.isArray(v)) { const out: Value[] = []; seen.set(v, out); for (const x of v) out.push(cloneValue(x, seen)); return out; }
  if (isPlain(v)) { const out = plain(); seen.set(v, out); for (const [k, x] of Object.entries(v)) out[k] = cloneValue(x, seen); return out; }
  return v;
}
/**
 * A copy of a stateful function's state (numbers, arrays and small objects of numbers). An array is copied whole, then each object in it:
 * a window holds up to `MAX_WINDOW` numbers, and every live update copies them all (`restore`).
 */
function cloneState(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = v.slice() as unknown[];
    for (let k = 0; k < out.length; k++) { const x = out[k]; if (x !== null && typeof x === 'object') out[k] = cloneState(x); }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = cloneState(x);
  return out;
}

/**
 * Read a script once, and run it whenever its inputs change. A run over the same closed candles as the run before (the candle under way is the
 * only one that changed, or new ones were added after it) starts from what the script held after the last candle that had closed then, so a
 * live update runs one candle, not five hundred. Anything else (other candles, other markets, the timeframe) runs every candle from the first.
 */
export function createRunner(id: string, source: string, optionValues: Record<string, OptionValue>, now: () => number = Date.now): ScriptRunner {
  let a: Analysis;
  try { a = analyze(source); }
  catch (e) { if (e instanceof ScriptSyntaxError) { const info = e.info; return { run: () => ({ id, ok: false, error: info }), startedAt: 0 }; } throw e; }
  let inputs: BarInputs = NO_INPUTS;
  let n = 0;
  const budget: Budget = { steps: 0, left: 0, deadline: 0, now };
  // The options: what was set, else the declared default; plain data copied into the script's own values.
  const opt = optionTable(a.declared, optionValues);
  // A script that writes its options changes what the next candle reads: it is always run from the first candle, from the options as set.
  const initialOptions = new Map(Object.entries(opt).map(([k, v]) => [k, cloneValue(v)]));
  let optionsWritten = false;
  const optionsObject = new HostObject('options', k => opt[k], (k, v) => { opt[k] = v; optionsWritten = true; return true; }, () => Object.keys(opt));

  // What persists: one value per name (any case: `Total` and `total` are one), starting at 0, and its value at the end of each candle (`name[n]`).
  const kept = new Map<string, { v: Value; past: Value[] }>();
  for (const name of a.persistent) kept.set(name.toLowerCase(), { v: 0, past: [] });
  const bindings = new Map<string, { get(): Value; set(v: Value): void }>();
  for (const [name, k] of kept) bindings.set(name, { get: () => k.v, set: v => { k.v = v; } });
  const byName = new Map<string, { get(): Value; set(v: Value): void } | null>();

  let i = 0;
  /** The longest window a run asked of a function counting back over candles, the window it has (at most `MAX_WINDOW`), and the line it was asked on. */
  let widest = { asked: 0, n: 0, line: 0 };
  const sourceStack: string[] = [''];
  const src = (): SourceInputs | undefined => inputs.sources[sourceStack[sourceStack.length - 1]!] ?? inputs.sources[''];
  const at = (arr: Float64Array | undefined): number => arr ? arr[i]! : NaN;
  const price = { color: '' as string, borderColor: '', wickColor: '' };
  // The chart's candle as the functions of a bar read it (`avg_ohlc(bar)`): one object, set at each candle, since no function keeps it.
  const candle: Candle = { open: NaN, high: NaN, low: NaN, close: NaN };
  let candleColors: string[] = [];
  let colored = false;
  const priceObject = new HostObject('$price', k => {
    switch (k) {
      case 'open': return inputs.open[i]; case 'high': return inputs.high[i]; case 'low': return inputs.low[i]; case 'close': return inputs.close[i];
      case 'volume': return inputs.volume[i];
      case 'color': return price.color; case 'borderColor': return price.borderColor; case 'wickColor': return price.wickColor;
      case 'time': return inputs.time[i]! / 1000;
      default: return undefined;
    }
  }, (k, v) => { if (k === 'color' || k === 'borderColor' || k === 'wickColor') { price[k] = typeof v === 'string' ? v : ''; if (k === 'color') { candleColors[i] = price.color.length <= 64 ? safeColor(price.color, '') : ''; if (candleColors[i]) colored = true; } return true; } return false; });
  const barObject = new HostObject('bar', k => {
    const s = src();
    switch (k) {
      case 'timestamp': return inputs.time[i]! / 1000;
      case 'vbuy': return at(s?.vbuy); case 'vsell': return at(s?.vsell); case 'lbuy': return at(s?.lbuy); case 'lsell': return at(s?.lsell);
      case 'cbuy': case 'csell': return NaN;
      case 'recorded': return at(s?.recorded);
      case 'oichg': return inputs.oichg ? inputs.oichg[i] : NaN;
      case 'open': return inputs.open[i]; case 'high': return inputs.high[i]; case 'low': return inputs.low[i]; case 'close': return inputs.close[i];
      case 'volume': return inputs.volume[i];
      default: return undefined;
    }
  });
  // The page's colours, read-only: whether its background is dark, and its background, text, up and down colours.
  const themeObject = new HostObject('theme', k => { const th = inputs.theme ?? DEFAULT_SCRIPT_THEME; return k === 'dark' ? th.dark : k === 'background' || k === 'text' || k === 'up' || k === 'down' ? th[k] : undefined; });
  const rendererObject = new HostObject('renderer', k => {
    switch (k) {
      case 'length': return i + 1;
      case 'timestamp': case 'localTimestamp': return inputs.time[i]! / 1000;
      case 'timeframe': return inputs.tf / 1000;
      case 'type': return 'time';
      case 'lastTradeTimestamp': return i === n - 1 && inputs.forming ? now() / 1000 : (inputs.time[i]! + inputs.tf) / 1000;
      case 'forming': return i === n - 1 && inputs.forming;
      // The newest candle the script reads, under way or closed (a replay, a market quiet since its last candle): where a label of the newest value goes.
      case 'last': return i === n - 1;
      default: return undefined;
    }
  });

  // The language's state per place in the text: functions (`sma` at line 3 is not `sma` at line 5), plots, and the order `fns[k]` counts them in.
  const instances = new Map<number, Instance>();
  const touched: Instance[] = [];
  const plots = new Map<number, PlotBuild>();
  const plotOrder: number[] = [];

  // `fns[k]` is the k-th call of a function that keeps state, in the order they are written; setting its `state` starts it again.
  const builtinSites: number[] = [];
  for (const [node, site] of numberSites(a.program)) if (node.k === 'call' && node.callee.k === 'id' && own(BUILTINS, node.callee.name)) builtinSites.push(site);
  const instanceAt = (site: number): Instance => { let inst = instances.get(site); if (!inst) { inst = makeInstance(); instances.set(site, inst); } return inst; };
  const fnsObject = new HostObject('fns', k => {
    const site = builtinSites[Number(k)];
    if (site === undefined) return undefined;
    return new HostObject('fn', key => key === 'state' ? plain() : undefined, key => { if (key !== 'state') return false; instanceAt(site).reset(); return true; });
  });

  // Without a prototype: `toString` or `constructor` are not names the table holds.
  const globals: Record<string, Value> = Object.assign(Object.create(null) as Record<string, Value>, {
    Math: mathObject(), Number: numberObject(), Infinity, NaN, undefined,
    String: new NativeFunction('String', args => text(args[0])), Boolean: new NativeFunction('Boolean', args => truthy(args[0])),
    isFinite: new NativeFunction('isFinite', args => Number.isFinite(num(args[0]))), isNaN: new NativeFunction('isNaN', args => Number.isNaN(num(args[0]))),
    parseFloat: new NativeFunction('parseFloat', args => parseFloat(text(args[0]))), parseInt: new NativeFunction('parseInt', args => parseInt(text(args[0]), args[1] === undefined ? 10 : num(args[1]))),
    Date: dateObject(now), Array: arrayObject(n => charge(budget, n)), Object: objectObject(),
    rgb: new NativeFunction('rgb', args => rgb(args.map(num))), rgba: new NativeFunction('rgba', args => rgb(args.map(num))),
    nz: new NativeFunction('nz', args => { const v = args[0]; return v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v)) ? (args.length > 1 ? args[1] : 0) : v; }),
    na: new NativeFunction('na', args => { const v = args[0]; return v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v)); }),
    option: new NativeFunction('option', () => undefined),
    source: new NativeFunction('source', () => undefined),
    alert: new NativeFunction('alert', () => undefined),
  });
  // The order book's functions work however they are reached (kept under another name, in an array or an object: `depthAt`).
  for (const name of DEPTH_FUNCTIONS) globals[name] = new NativeFunction(name, args => depthAt(name, args));
  for (const name of Object.keys(BUILTINS)) globals[name] = new NativeFunction(name, () => undefined);
  for (const name of Object.keys(PLOTS)) if (!Object.prototype.hasOwnProperty.call(globals, name)) globals[name] = new NativeFunction(name, () => undefined);

  const host: Host = {
    global(name) {
      switch (name) {
        case 'time': return { known: true, value: inputs.time[i]! / 1000 };
        case 'vbuy': return { known: true, value: at(src()?.vbuy) };
        case 'vsell': return { known: true, value: at(src()?.vsell) };
        case 'lbuy': return { known: true, value: at(src()?.lbuy) };
        case 'lsell': return { known: true, value: at(src()?.lsell) };
        case 'cbuy': case 'csell': return { known: true, value: NaN };
        case 'oichg': return { known: true, value: inputs.oichg ? inputs.oichg[i]! : NaN };
        case 'bar': return { known: true, value: barObject };
        case '$price': return { known: true, value: priceObject };
        case 'options': return { known: true, value: optionsObject };
        case 'renderer': return { known: true, value: rendererObject };
        case 'theme': return { known: true, value: themeObject };
        case 'fns': return { known: true, value: fnsObject };
      }
      if (Object.prototype.hasOwnProperty.call(globals, name)) return { known: true, value: globals[name] };
      const color = own(COLOR_NAMES, name.toLowerCase());
      if (color !== undefined) return { known: true, value: color };
      return { known: false, value: undefined };
    },
    persistent: name => { let b = byName.get(name); if (b === undefined) { b = bindings.get(name.toLowerCase()) ?? null; byName.set(name, b); } return b; },
    history(name, back) {
      const k = kept.get(name.toLowerCase());
      // A kept array or object is indexed as one (`levels[0]`); only a kept number or text has a history.
      if (!k || Array.isArray(k.v) || isPlain(k.v)) return null;
      if (!Number.isInteger(back) || back < 0) return { value: undefined };
      if (back === 0) return { value: k.v };
      // Further back than has been kept reads the oldest there is (on the first candle `x[1]` is `x` itself).
      return { value: k.past.length ? k.past[Math.max(0, k.past.length - back)] : k.v };
    },
    callNative(fn, args, named, site, node) {
      const name = fn.name;
      if (node.callee.k !== 'id') return fn.call(args, named);
      if (name === 'option') { const target = optionTarget(node); return target !== null ? opt[target] : args[0] ?? named?.default; }
      if (name === 'source') return args[0];
      if (name === 'alert') { alertAt(site, args, named); return undefined; }
      if (DEPTH_FUNCTIONS.has(name)) return depthAt(name, args);
      const plotKind = own(PLOTS, name);
      if (plotKind) { plot(site, plotKind, args, named); return undefined; }
      const builtin = own(BUILTINS, name);
      if (builtin) {
        const k = own(WINDOW_ARG, name);
        // The window asked, and as the function takes it: at most MAX_WINDOW candles, and one that is not a number (Infinity too) is one candle.
        if (k !== undefined) { const a = Math.floor(num(args[k])), asked = Number.isFinite(a) ? a : 1; if (asked > widest.asked) widest = { asked, n: Math.min(MAX_WINDOW, asked), line: node.p.line }; }
        const inst = instanceAt(site);
        if (!inst.touched) { inst.touched = true; touched.push(inst); }
        return builtin(inst, args, named, candle);
      }
      return fn.call(args, named);
    },
  };

  // A script that only alerts draws nothing and is not warned of it.
  let alertSites = 0;
  for (const node of numberSites(a.program).keys()) if (node.k === 'call' && node.callee.k === 'id' && node.callee.name === 'alert') alertSites++;
  // `source(expr, ...)`: the inputs inside `expr` are read over the call's markets. The argument is evaluated by the interpreter, so the
  // interpreter is told which set to read while it does: the call is found by its place, before its arguments are read.
  const sourceSites = new Map<Expr, string>();
  const sites = numberSites(a.program);
  // Each set's filter by its key, for the order book (the flow is handed over per set; the book is filtered in the worker).
  const filters = new Map<string, SourceFilter>([['', {}]]);
  for (const node of sites.keys()) if (node.k === 'call' && node.callee.k === 'id' && node.callee.name === 'source') { const f = sourceFilter(node.named, opt), k = filterKey(f); sourceSites.set(node, k); filters.set(k, f); }
  /**
   * `askdepth(usd)` / `biddepth(usd)`: the price at which the asks above the candle's close (the bids below it) add up to `usd` dollars;
   * `depthabove(usd)` / `depthbelow(usd)` the same over every dollar recorded at each price, bids and asks alike (`depth.ts` says why);
   * `depthbooks()`: how many of the books read have depth at this candle. `depthatclose()`: whether every book read at this candle is its book
   * at the close (false where any is an average over it, from a source from before; NaN where none is held). Over the books of the set being
   * read (`source(...)`), NaN where nothing is known. The work the book took is paid from the step budget.
   */
  const depthAt = (name: string, args: Value[]): Value => {
    charge(budget, 8);
    const reader = inputs.depth;
    if (!reader) return NaN;
    const key = sourceStack[sourceStack.length - 1]!, filter = filters.get(key) ?? {};
    const walk = name === 'askdepth' ? 'ask' : name === 'biddepth' ? 'bid' : name === 'depthabove' ? 'above' : 'below';
    const at = name === 'depthatclose' ? reader.atClose(inputs.time[i]!, filter, key) : 0;
    const value = name === 'depthbooks' ? reader.books(inputs.time[i]!, filter, key) : name === 'depthatclose' ? Number.isNaN(at) ? NaN : at === 1 : reader.reach(walk, inputs.time[i]!, inputs.close[i]!, args.length ? num(args[0]) : NaN, filter, key);
    const spent = reader.spent();
    if (spent > 0) charge(budget, Math.ceil(spent / 4));
    return value;
  };
  const readsDepth = a.inputs.has('depth');
  const optionTargets = new Map<Expr, string>();
  const noteTargets = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(noteTargets); return; }
    const x = node as Expr | Stmt;
    if ('k' in x) {
      if (x.k === 'assign' && x.target.k === 'id' && x.value.k === 'call') optionTargets.set(x.value, x.target.name);
      if (x.k === 'decl') for (const d of x.items) if (d.init?.k === 'call') optionTargets.set(d.init, d.name);
    }
    for (const v of Object.values(x)) if (v && typeof v === 'object') noteTargets(v);
  };
  noteTargets(a.program);
  const optionTarget = (node: Expr): string | null => optionTargets.get(node) ?? null;

  // Every plot call in the text is one plot, in the order written, whether or not it ever runs (one inside an `if` that is never true stays
  // empty). Its style starts from the named arguments that can be read without running the script (literals, options), and the first call
  // that runs adds what it gives.
  const styled = new Set<number>();
  const initialStyles = new Map<number, { title: string; style: Record<string, OptionValue> }>();
  const scriptNames = new Set([...declaredNames(a.program), ...a.persistent]);
  for (const [node, site] of sites) {
    if (node.k !== 'call' || node.callee.k !== 'id') continue;
    const kind = own(PLOTS, node.callee.name);
    if (!kind) continue;
    if (plots.size >= MAX_PLOTS) { const error = { code: 'too-many-plots', line: node.p.line, col: node.p.col }; return { run: () => ({ id, ok: false, error }), startedAt: 0 }; }
    const fields: Record<string, Float64Array> = {};
    for (const f of PLOT_FIELDS[kind]) fields[f] = new Float64Array(n).fill(NaN);
    const style: Record<string, OptionValue> = {};
    for (const nm of node.named) { const v = styleData(staticValue(nm.value, opt, scriptNames)); if (v !== undefined) style[nm.name] = v; }
    const title = typeof style.title === 'string' ? style.title.slice(0, MAX_TITLE) : typeof style.title === 'number' ? String(style.title) : '';
    plots.set(site, { kind, title, style, fields, colors: null, texts: null, tips: null });
    initialStyles.set(site, { title, style: { ...style } });
    plotOrder.push(site);
  }

  function plot(site: number, kind: PlotKind, args: Value[], named: Record<string, Value> | null): void {
    const p = plots.get(site);
    if (!p || p.kind !== kind) return;
    if (named && !styled.has(site)) {
      styled.add(site);
      for (const [k, v] of Object.entries(named)) { const d = styleData(toData(v)); if (d !== undefined && !(k in p.style)) p.style[k] = d; }
      if (!p.title && typeof named.title === 'string') p.title = named.title.slice(0, MAX_TITLE);
    }
    // A call with no value (only named arguments) makes its plot and draws nothing.
    if (!args.length) return;
    const point = args[0];
    if (kind === 'mark') {
      // A mark's value, text and tip: mark(value, text, tip) or mark({value, text, tip, color}); a value that is not a number draws none.
      const o = isPlain(point) ? point : null, v = o ? o.value : point;
      const value = typeof v === 'number' ? v : v === undefined || v === null ? NaN : num(v);
      p.fields.value![i] = value;
      if (!Number.isFinite(value)) return;
      const said = (x: Value | undefined, max: number): string => x === undefined || x === null ? '' : text(x).slice(0, max);
      const label = said(o ? o.text : args[1], MARK_TEXT), tip = said(o ? o.tip : args[2], MARK_TIP);
      charge(budget, 1 + ((label.length + tip.length) >> 4));
      if (label) (p.texts ??= new Array<string>(n).fill(''))[i] = label;
      if (tip) (p.tips ??= new Array<string>(n).fill(''))[i] = tip;
      setColor(p, o ? o.color : args[3]);
      return;
    }
    if (isPlain(point)) {
      for (const f of PLOT_FIELDS[kind]) { const v = point[f]; p.fields[f]![i] = typeof v === 'number' ? v : v === undefined || v === null ? NaN : num(v); }
      if (kind === 'line' || kind === 'area' || kind === 'histogram' || kind === 'baseline') { if (point.value === undefined && typeof point.close === 'number') p.fields.value![i] = point.close; }
      setColor(p, point.color);
      return;
    }
    const fields = PLOT_FIELDS[kind];
    for (let f = 0; f < fields.length; f++) { const v = args[f]; p.fields[fields[f]!]![i] = typeof v === 'number' ? v : v === undefined || v === null ? NaN : num(v); }
    if (named && typeof named.color === 'string' && kind === 'histogram') setColor(p, named.color);
  }
  /** A point's own colour, when it reads as one. */
  function setColor(p: PlotBuild, c: Value): void {
    if (typeof c !== 'string' || !c) return;
    const color = c.length <= 64 ? safeColor(c, '') : '';
    if (!color) return;
    if (!p.colors) p.colors = new Array<string>(n).fill('');
    p.colors[i] = color;
  }
  /**
   * The alerts of a run, from its newest candles only: the one under way and the last one closed (`alertsFrom`). Older candles are history
   * a run never hands back; one call in the text makes at most one alert a candle, and a candle at most `MAX_ALERTS` (the first calls made),
   * so a run of the candle under way alone hands back the same ones as a run of every candle.
   */
  let alerts: AlertOut[] = [];
  let alertsFrom = 0;
  function alertAt(site: number, args: Value[], named: Record<string, Value> | null): void {
    if (i < alertsFrom) return;
    const t = inputs.time[i]!;
    let here = 0;
    for (const a of alerts) if (a.t === t) { if (a.site === site) return; here++; }
    if (here >= MAX_ALERTS) return;
    const said = args[0] === undefined || args[0] === null ? '' : text(args[0]).slice(0, ALERT_TEXT);
    charge(budget, 1 + (said.length >> 4));
    const asked = typeof named?.sound === 'string' ? named.sound.toLowerCase() : '';
    const sound: AlertSound = (ALERT_SOUNDS as readonly string[]).includes(asked) ? asked as AlertSound : 'chime';
    alerts.push({ site, t, text: said, sound, when: named?.when === 'close' ? 'close' : 'bar', forming: i === n - 1 && inputs.forming });
  }
  /** A histogram bar of 0 is not drawn (an empty candle leaves no stub). */
  const dropZeros = (): void => { for (const p of plots.values()) if (p.kind === 'histogram') { const v = p.fields.value!; for (let k = 0; k < n; k++) if (v[k] === 0) v[k] = NaN; } };

  // The interpreter evaluates a call's arguments before the host sees the call: `source` puts its set in place before its arguments are read.
  host.aroundCall = (node, run) => {
    const key = sourceSites.get(node);
    if (key === undefined) return run();
    sourceStack.push(key);
    try { return run(); } finally { sourceStack.pop(); }
  };
  // Only those calls: wrapping every call cost each one a function made for it.
  host.wrapsCall = node => sourceSites.has(node);
  // A plot's named arguments are its style, read on its first call; `source`, `option` and the stateful functions take theirs from the text.
  host.wantsNamed = (fn, site) => own(PLOTS, fn.name) !== undefined ? !styled.has(site) : !(fn.name === 'source' || fn.name === 'option' || own(BUILTINS, fn.name));
  host.construct = (name, args) => {
    if (name === 'Date') return new DateValue(args.length ? (args[0] instanceof DateValue ? args[0].ms : num(args[0])) : now());
    const len = num(args[0]);
    if (args.length === 1 && Number.isInteger(len) && len >= 0 && len <= 1_000_000) { charge(budget, len); return new Array<Value>(len).fill(undefined); }
    if (args.length === 1 && typeof args[0] === 'number') throw new ScriptRuntimeError('too-large', 0, 0, 'array');
    return [...args];
  };
  const interp = new Interpreter(a.program, host, budget);

  /** What the script held after candle `at` of `inputs` had closed, and what it had drawn by then. */
  interface Snapshot { at: number; inputs: BarInputs; kept: Map<string, { v: Value; past: Value[] }>; states: Map<number, unknown>; fields: Map<number, Record<string, Float64Array>>; colors: Map<number, string[] | null>; texts: Map<number, [string[] | null, string[] | null]>; candleColors: string[]; styles: Map<number, { title: string; style: Record<string, OptionValue> }>; styled: Set<number>; widest: { asked: number; n: number; line: number } }
  let snap: Snapshot | null = null;
  /**
   * Whether what the script holds can be put back exactly: kept names holding plain values (numbers, texts, true/false, dates) and options it
   * never wrote. An array, an object or a function kept from candle to candle can be shared or hold state a copy would not, so a script that
   * keeps one always runs every candle.
   */
  const restorable = (): boolean => {
    if (optionsWritten) return false;
    const simple = (v: Value): boolean => v === null || v === undefined || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || v instanceof DateValue;
    // An option that is an array or an object can be changed in place, which the options' setter does not see.
    for (const v of Object.values(opt)) if (!simple(v)) return false;
    for (const k of kept.values()) { if (!simple(k.v)) return false; for (const x of k.past) if (!simple(x)) return false; }
    return true;
  };
  const take = (at: number): Snapshot => ({
    at, inputs,
    kept: new Map([...kept].map(([name, k]) => [name, { v: cloneValue(k.v), past: k.past.map(x => cloneValue(x)) }])),
    states: new Map([...instances].map(([site, inst]) => [site, cloneState(inst.state)])),
    fields: new Map([...plots].map(([site, p]) => [site, p.fields])),
    colors: new Map([...plots].map(([site, p]) => [site, p.colors])),
    texts: new Map([...plots].map(([site, p]) => [site, [p.texts, p.tips]])),
    candleColors,
    styles: new Map([...plots].map(([site, p]) => [site, { title: p.title, style: JSON.parse(JSON.stringify(p.style)) as Record<string, OptionValue> }])),
    styled: new Set(styled),
    widest: { ...widest },
  });
  /** Put back what the script held after candle `snap.at`. */
  const restore = (from: Snapshot): void => {
    for (const [name, k] of kept) { const was = from.kept.get(name); k.v = was ? cloneValue(was.v) : 0; k.past = was ? was.past.map(x => cloneValue(x)) : []; }
    for (const [site, inst] of instances) { inst.pending = null; inst.touched = false; inst.state = from.states.has(site) ? cloneState(from.states.get(site)) as Record<string, unknown> : {}; }
    // A plot first styled on a candle after the snapshot is styled again by the run that takes that candle over.
    styled.clear(); for (const site of from.styled) styled.add(site);
    for (const [site, p] of plots) { const was = from.styles.get(site); if (was) { p.title = was.title; p.style = JSON.parse(JSON.stringify(was.style)) as Record<string, OptionValue>; } }
    // The longest window the candles taken over asked: a run of the newest candles alone warns as a run of all of them would.
    widest = { ...from.widest };
  };
  /** Start from nothing: every kept name at 0, every function's state empty. */
  const fresh = (): void => {
    for (const k of kept.values()) { k.v = 0; k.past = []; }
    for (const inst of touched) inst.touched = false;
    touched.length = 0;
    instances.clear();
    // The options as they were set, and each plot's style as the text gives it: the first call that runs styles it again.
    for (const key of Object.keys(opt)) delete opt[key];
    for (const [k, v] of initialOptions) opt[k] = cloneValue(v);
    optionsWritten = false;
    styled.clear();
    for (const [site, p] of plots) { const s0 = initialStyles.get(site)!; p.title = s0.title; p.style = { ...s0.style }; }
    widest = { asked: 0, n: 0, line: 0 };
  };

  const runner = {
    startedAt: 0,
    run(next: BarInputs): ScriptResult {
      const started = now(), before = inputs;
      inputs = next; n = next.time.length;
      // From the candle after the last one that had closed at the run before, when every candle before it is the same.
      // A closed candle whose order book changed since (a window settled, a book added) is run again with every candle after it.
      const start = snap && snap.at === snap.inputs.time.length - 2 && snap.at + 1 < n && sameCandles(snap.inputs, next, snap.at + 1) && (!readsDepth || sameDepth(snap.inputs, next, snap.at + 1)) ? snap.at + 1 : 0;
      const from = start > 0 ? snap : null;
      if (from) restore(from); else { fresh(); snap = null; }
      runner.startedAt = start;
      // A live update (the newest candles alone) has RUN_MS, and so does a run from the first candle over the candles the run before had, its
      // newest changed or new ones after them: a script that keeps an array or writes its options cannot be put back, so it runs every candle
      // at every update, and FULL_RUN_MS would let each update take ten seconds (Sol, 2026-11-10). Other candles (a chart opened, more history,
      // a setting, a script changed) have FULL_RUN_MS, as the worker host allows (`host.ts`).
      // Fewer candles than the run before (a replay stepped back) is not one, nor are closed candles whose order book changed (a window settled):
      // those run from the first candle with the long time (Sol, rounds 5 and 6).
      const update = start > 0 || (before.time.length >= 2 && n >= before.time.length && sameCandles(before, next, before.time.length - 1) && (!readsDepth || sameDepth(before, next, before.time.length - 1)));
      budget.steps = 0; budget.left = Math.max(200_000, STEPS_PER_CANDLE * (n - start)); budget.deadline = started + (update ? RUN_MS : FULL_RUN_MS);
      const warnings = [...a.warnings];
      // The plots' numbers: those of the candles taken over, then NaN until the run gives them.
      for (const [site, p] of plots) {
        const fields: Record<string, Float64Array> = {};
        for (const f of PLOT_FIELDS[p.kind]) { const arr = new Float64Array(n).fill(NaN); const old = from?.fields.get(site)?.[f]; if (old) arr.set(old.subarray(0, start)); fields[f] = arr; }
        p.fields = fields;
        const oldColors = from?.colors.get(site) ?? null;
        p.colors = oldColors ? [...oldColors.slice(0, start), ...new Array<string>(n - start).fill('')] : null;
        // A mark's texts and tips of the candles taken over, as its colours are.
        const [oldTexts, oldTips] = from?.texts.get(site) ?? [null, null];
        p.texts = oldTexts ? [...oldTexts.slice(0, start), ...new Array<string>(n - start).fill('')] : null;
        p.tips = oldTips ? [...oldTips.slice(0, start), ...new Array<string>(n - start).fill('')] : null;
      }
      alerts = []; alertsFrom = Math.max(0, inputs.forming ? n - 2 : n - 1);
      candleColors = from ? from.candleColors.slice(0, start) : [];
      colored = candleColors.some(c => c);
      try {
        for (i = start; i < n; i++) {
          price.color = ''; price.borderColor = ''; price.wickColor = '';
          candle.open = inputs.open[i]!; candle.high = inputs.high[i]!; candle.low = inputs.low[i]!; candle.close = inputs.close[i]!;
          interp.runOnce();
          for (const inst of touched) { inst.commit(); inst.touched = false; }
          touched.length = 0;
          for (const k of kept.values()) { k.past.push(k.v); if (k.past.length > 4_096) k.past.splice(0, k.past.length - 2_048); }
          // After the last candle that has closed: what the next run over the same candles starts from.
          if (i === n - 2) snap = restorable() ? take(i) : null;
        }
      } catch (e) {
        snap = null;
        for (const inst of touched) { inst.touched = false; inst.pending = null; }
        touched.length = 0;
        if (e instanceof ScriptRuntimeError) return { id, ok: false, error: { code: e.code, line: e.line, col: e.col, ...(e.detail ? { detail: e.detail } : {}) } };
        if (e instanceof RangeError) return { id, ok: false, error: { code: 'too-deep', line: 0, col: 0 } };
        throw e;
      }
      // A run of the candle under way alone keeps the snapshot of the run before (its closed candles are the same); a run over no closed candle has none.
      if (n < 2 || optionsWritten) snap = null;
      // "line|asked|window|candles": a window that never fills here, or one asked longer than any window can be (the window is then MAX_WINDOW).
      if (n > 0 && (widest.n > n || widest.asked > widest.n)) warnings.push({ code: 'long-window', detail: `${widest.line}|${widest.asked}|${widest.n}|${n}` });
      dropZeros();
      const out: PlotOut[] = plotOrder.map(site => { const p = plots.get(site)!; return { kind: p.kind, title: p.title, style: p.style, fields: p.fields, colors: p.colors, ...(p.kind === 'mark' ? { texts: p.texts, tips: p.tips } : {}) }; });
      if (!out.length && !colored && !alertSites) warnings.push({ code: 'no-plots' });
      return { id, ok: true, plots: out, warnings, steps: budget.steps, ms: now() - started, ...(colored ? { candleColors: Array.from({ length: n }, (_, k) => candleColors[k] ?? '') } : {}), ...(alerts.length ? { alerts } : {}) };
    },
  };
  return runner;
}

function mathObject(): HostObject {
  const fns: Record<string, (...a: number[]) => number> = {
    abs: Math.abs, max: Math.max, min: Math.min, sqrt: Math.sqrt, pow: Math.pow, log: Math.log, log10: Math.log10, log2: Math.log2, log1p: Math.log1p, exp: Math.exp, expm1: Math.expm1,
    floor: Math.floor, ceil: Math.ceil, round: Math.round, trunc: Math.trunc, sign: Math.sign, cbrt: Math.cbrt, hypot: Math.hypot,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    random: Math.random,
  };
  const consts: Record<string, number> = { PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10, LOG2E: Math.LOG2E, LOG10E: Math.LOG10E, SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2 };
  const made = new Map<string, NativeFunction>();
  return new HostObject('Math', k => {
    const c = own(consts, k); if (c !== undefined) return c;
    const f = own(fns, k); if (!f) return undefined;
    let nf = made.get(k);
    if (!nf) { nf = new NativeFunction(k, args => f(...args.map(num))); made.set(k, nf); }
    return nf;
  });
}

function numberObject(): NativeFunction {
  const consts: Record<string, number> = { EPSILON: Number.EPSILON, MAX_VALUE: Number.MAX_VALUE, MIN_VALUE: Number.MIN_VALUE, MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER, MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER, POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity, NaN };
  const fns: Record<string, NativeFunction> = {
    isFinite: new NativeFunction('isFinite', a => typeof a[0] === 'number' && Number.isFinite(a[0])),
    isNaN: new NativeFunction('isNaN', a => typeof a[0] === 'number' && Number.isNaN(a[0])),
    isInteger: new NativeFunction('isInteger', a => typeof a[0] === 'number' && Number.isInteger(a[0])),
    parseFloat: new NativeFunction('parseFloat', a => parseFloat(text(a[0]))),
    parseInt: new NativeFunction('parseInt', a => parseInt(text(a[0]), a[1] === undefined ? 10 : num(a[1]))),
  };
  const members = new HostObject('Number', k => own(consts, k) ?? own(fns, k));
  return new NativeFunction('Number', a => a.length ? num(a[0]) : 0, null, members);
}

function dateObject(now: () => number): HostObject {
  return new HostObject('Date', k => k === 'now' ? new NativeFunction('now', () => now()) : k === 'UTC' ? new NativeFunction('UTC', a => Date.UTC(num(a[0]), num(a[1] ?? 0), num(a[2] ?? 1), num(a[3] ?? 0), num(a[4] ?? 0), num(a[5] ?? 0))) : undefined);
}
function arrayObject(pay: (n: number) => void): HostObject {
  const from = (a: Value[]): Value[] => {
    if (Array.isArray(a[0])) { pay(a[0].length); return [...a[0]]; }
    const n = isPlain(a[0]) && typeof a[0].length === 'number' ? Math.max(0, Math.min(Math.floor(a[0].length), 1_000_000)) : 0;
    pay(n);
    return new Array<Value>(Number.isFinite(n) ? n : 0).fill(undefined);
  };
  return new HostObject('Array', k => k === 'isArray' ? new NativeFunction('isArray', a => Array.isArray(a[0])) : k === 'from' ? new NativeFunction('from', from) : undefined);
}
function objectObject(): HostObject {
  const own = (v: Value): [string, Value][] => isPlain(v) ? Object.entries(v) : Array.isArray(v) ? v.map((x, i) => [String(i), x] as [string, Value]) : v instanceof HostObject && v.keys ? v.keys().map(k => [k, v.get(k)] as [string, Value]) : [];
  return new HostObject('Object', k => {
    if (k === 'keys') return new NativeFunction('keys', a => own(a[0]).map(e => e[0]));
    if (k === 'values') return new NativeFunction('values', a => own(a[0]).map(e => e[1]));
    if (k === 'entries') return new NativeFunction('entries', a => own(a[0]).map(e => [e[0], e[1]]));
    if (k === 'assign') return new NativeFunction('assign', a => { const t = a[0]; if (!isPlain(t)) return t; for (const s of a.slice(1)) for (const [kk, v] of own(s)) if (kk !== '__proto__') t[kk] = v; return t; });
    return undefined;
  });
}

export { DateValue, interpolateColors };
export { API_VERSION, MAX_PLOTS, MAX_SOURCES, UNREAD_VENUE, analyze, exchangeOf, optionTable, persistentNames, sourceFilter, sourcesWith, type Analysis } from './analysis.ts';
export type { ScriptError };
