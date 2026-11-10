import { parse, type Expr, type Stmt } from './parser.ts';
import { ScriptSyntaxError } from './lexer.ts';
import { declaredNames } from './walk.ts';
import { fromData, own, plain, type Value } from './values.ts';
import { rgb } from './colors.ts';
import type { OptionDecl, PlotKind, Warning } from '../protocol.ts';
import { filterKey, type SourceFilter } from '../inputs.ts';
import type { OptionValue } from '../records.ts';

/**
 * Reading a script without running it: what it declares (its options), which sets of markets it reads (`source(...)`), which names it keeps
 * from candle to candle, what it cannot do here. The page reads scripts with this alone (the panel, the pane's inputs); running them is
 * `engine.ts`, in the worker.
 */

export const API_VERSION = 2;

/** The plot functions and the kind each draws. */
export const PLOTS: Readonly<Record<string, PlotKind>> = {
  plotline: 'line', line: 'line', plotarea: 'area', area: 'area', plothistogram: 'histogram', histogram: 'histogram',
  plotbaseline: 'baseline', baseline: 'baseline', plotcandlestick: 'candlestick', candlestick: 'candlestick', plotbar: 'bar', bar_plot: 'bar',
  plotcloudarea: 'cloudarea', cloudarea: 'cloudarea', plotbrokenarea: 'brokenarea', brokenarea: 'brokenarea',
  mark: 'mark', plotmark: 'mark',
};

/** The most plots a script may make, and the most named sets of markets it may read. */
export const MAX_PLOTS = 64, MAX_SOURCES = 24;
/**
 * The steps a run may take per candle (on average), and its time: `RUN_MS` for a run of the newest candles alone (a live update, which takes
 * the closed candles over from the run before), `FULL_RUN_MS` for a run from the first candle (a chart opened, a script or its options
 * changed, or a candle before the newest changed). The worker host gives each script the longer time before it ends the worker (`host.ts`).
 */
export const STEPS_PER_CANDLE = 40_000, RUN_MS = 2_500, FULL_RUN_MS = 10_000;

export interface Analysis {
  program: Stmt[];
  /** The `source(...)` calls, for their filters (`sourcesWith`). */
  sourceCalls: Extract<Expr, { k: 'call' }>[];
  /** The candle inputs it reads (`vbuy`, `lsell`, `oichg`, ...). */
  inputs: Set<string>;
  /** Names kept from candle to candle. */
  persistent: Set<string>;
  /** The sets of markets the script reads (`source(...)`), by key, with their filters ('' is always there). */
  sources: Map<string, SourceFilter>;
  /** Options it declares (`option(...)`), in the order they appear. */
  declared: OptionDecl[];
  /** `options.name` it reads. */
  read: string[];
  warnings: Warning[];
}

/** The functions that read the order book (`depth.ts`); like the names version 2 added, not in `KNOWN_INPUTS`: a script's own name of one stays its own. */
export const DEPTH_FUNCTIONS = new Set(['askdepth', 'biddepth', 'depthabove', 'depthbelow', 'depthbooks', 'depthatclose']);

/** What `renderer` answers when a script runs (the engine's `rendererObject`); any other member reads nothing and is warned of. */
export const RENDERER_MEMBERS = new Set(['length', 'timestamp', 'localTimestamp', 'timeframe', 'type', 'lastTradeTimestamp', 'forming']);
/** What `theme` answers (the engine's `themeObject`). */
export const THEME_MEMBERS = new Set(['dark', 'background', 'text', 'up', 'down']);
export const KNOWN_INPUTS = new Set(['time', 'vbuy', 'vsell', 'cbuy', 'csell', 'lbuy', 'lsell', 'bar', '$price', 'options', 'renderer', 'fns', 'Math', 'Number', 'String', 'Boolean', 'Date', 'Array', 'Object', 'JSON', 'Infinity', 'NaN', 'undefined', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'rgb', 'rgba', 'option', 'source', 'nz', 'na']);
/**
 * Names version 2 added (`oichg`, `alert`, `theme`) are not in `KNOWN_INPUTS`: a script written before them that uses one as its own name keeps it,
 * since a script's own names are looked up before the page's.
 */

/** An exchange's name as scripts write it, as the page's exchange (and the kind its name implies, where it does). */
export function exchangeOf(name: string): { venue: string; kind?: 'spot' | 'perp' } {
  const n = name.trim().toUpperCase();
  return own(EXCHANGES, n) ?? { venue: n.toLowerCase().replace(/_futures$/, '') };
}

/** The exchanges as scripts name them (`source(vbuy, exchange=BINANCE)`), with the page's venue and the kind of market a name implies. */
export const EXCHANGES: Readonly<Record<string, { venue: string; kind?: 'spot' | 'perp' }>> = {
  BINANCE: { venue: 'binance', kind: 'spot' }, BINANCE_FUTURES: { venue: 'binance', kind: 'perp' }, BINANCE_US: { venue: 'binanceus', kind: 'spot' },
  OKEX: { venue: 'okx' }, OKX: { venue: 'okx' }, HUOBI: { venue: 'htx' }, HTX: { venue: 'htx' }, GATEIO: { venue: 'gateio' }, GATE: { venue: 'gateio' },
  CRYPTOCOM: { venue: 'cryptocom' }, KRAKEN: { venue: 'kraken' }, KRAKEN_FUTURES: { venue: 'kraken', kind: 'perp' }, BITFINEX: { venue: 'bitfinex' },
  BITSTAMP: { venue: 'bitstamp', kind: 'spot' }, COINBASE: { venue: 'coinbase', kind: 'spot' }, BITMEX: { venue: 'bitmex', kind: 'perp' }, DERIBIT: { venue: 'deribit', kind: 'perp' },
  DYDX: { venue: 'dydx', kind: 'perp' }, HYPERLIQUID: { venue: 'hyperliquid', kind: 'perp' }, BYBIT: { venue: 'bybit' }, BITGET: { venue: 'bitget' }, KUCOIN: { venue: 'kucoin' },
  MEXC: { venue: 'mexc' }, PHEMEX: { venue: 'phemex' }, POLONIEX: { venue: 'poloniex', kind: 'spot' }, WHITEBIT: { venue: 'whitebit' }, ASTER: { venue: 'aster', kind: 'perp' },
};

/** A literal value of a call's named argument read without running the script (a number, a text, a plain word, true/false, `rgb(...)`), or undefined. */
export function literal(e: Expr): OptionValue | undefined {
  if (e.k === 'num' || e.k === 'str') return e.v;
  if (e.k === 'id') return e.name === 'true' ? true : e.name === 'false' ? false : e.name === 'null' ? null : e.name;
  if (e.k === 'un' && e.op === '-' && e.arg.k === 'num') return -e.arg.v;
  if (e.k === 'call' && e.callee.k === 'id' && (e.callee.name === 'rgb' || e.callee.name === 'rgba') && e.args.every(a => a.k === 'num' || (a.k === 'un' && a.arg.k === 'num'))) return rgb(e.args.map(a => Number(literal(a))));
  if (e.k === 'arr') { const items = e.items.map(literal); return items.every(x => x !== undefined) ? items as OptionValue[] : undefined; }
  return undefined;
}


/** The venue a filter names when its value cannot be read: it matches no market, so an unread filter reads 0 rather than every market. */
export const UNREAD_VENUE = '?';

/**
 * A `source(...)` call's filter from its named arguments (`type`, `exchange`, `quote`; more than one value as `exchange=A+B`). A value is a
 * literal or a plain word, an option (`options.venue`, or a declared option's name: read from `opt`), or the text as written (`A+B`). A value
 * that is none of those cannot be known before the script runs: the filter then matches no market (`UNREAD_VENUE`).
 */
export function sourceFilter(named: readonly { name: string; value: Expr; raw?: string }[], opt: Readonly<Record<string, Value>> = {}): SourceFilter {
  const kinds: ('spot' | 'perp')[] = [], venues: string[] = [], quotes: string[] = [];
  for (const n of named) {
    if (n.name !== 'type' && n.name !== 'exchange' && n.name !== 'quote') continue;
    let v: unknown;
    if (n.value.k === 'member' && n.value.obj.k === 'id' && n.value.obj.name === 'options') v = opt[n.value.name];
    else if (n.value.k === 'id' && Object.prototype.hasOwnProperty.call(opt, n.value.name)) v = opt[n.value.name];
    else { v = literal(n.value); if (typeof v !== 'string' && n.raw && /^[\w+|, -]+$/.test(n.raw)) v = n.raw; }
    if (typeof v !== 'string' || !v.trim()) { venues.push(UNREAD_VENUE); continue; }
    const words = v.split(/[+,|\s]+/).filter(Boolean);
    if (n.name === 'type') for (const w of words) { const k = w.toLowerCase(); if (k === 'spot') kinds.push('spot'); else if (k === 'perp' || k === 'perpetual' || k === 'futures' || k === 'linear' || k === 'inverse') kinds.push('perp'); }
    if (n.name === 'exchange') for (const w of words) { const x = exchangeOf(w); venues.push(x.kind ? `${x.venue}/${x.kind}` : x.venue); }
    if (n.name === 'quote') for (const w of words) quotes.push(w.toUpperCase());
  }
  return { ...(kinds.length ? { kinds } : {}), ...(venues.length ? { venues } : {}), ...(quotes.length ? { quotes } : {}) };
}

/** The options' values a script runs with: those set, else the declared defaults (as script values). */
export function optionTable(declared: readonly OptionDecl[], optionValues: Readonly<Record<string, OptionValue>>): Record<string, Value> {
  const opt = plain();
  for (const d of declared) opt[d.name] = fromData(d.value);
  for (const [k, v] of Object.entries(optionValues)) opt[k] = fromData(v);
  return opt;
}

/** The sets of markets a script reads with these option values, by key ('' always there). */
export function sourcesWith(a: Pick<Analysis, 'sourceCalls' | 'declared'>, optionValues: Readonly<Record<string, OptionValue>>): Map<string, SourceFilter> {
  const opt = optionTable(a.declared, optionValues), out = new Map<string, SourceFilter>([['', {}]]);
  for (const c of a.sourceCalls) { const f = sourceFilter(c.named, opt); out.set(filterKey(f), f); }
  return out;
}

/**
 * The names a script keeps from candle to candle: those it assigns (`x = ...`) where no declaration reaches, neither one of the function the
 * assignment is in (its parameters, its `var`, `let`, `const` and functions) nor one outside every function.
 */
export function persistentNames(program: readonly Stmt[]): Set<string> {
  const out = new Set<string>();
  const declaredIn = (body: readonly Stmt[], params: readonly string[]): Set<string> => {
    const names = new Set(params);
    const walk = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      const n = x as Expr | Stmt;
      if ('k' in n) {
        if (n.k === 'fn') return;
        if (n.k === 'func') { names.add(n.name); return; }
        if (n.k === 'decl') for (const d of n.items) names.add(d.name);
      }
      for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
    };
    body.forEach(walk);
    return names;
  };
  const visit = (x: unknown, scopes: readonly Set<string>[]): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) visit(y, scopes); return; }
    const n = x as Expr | Stmt;
    if ('k' in n) {
      if (n.k === 'func' || n.k === 'fn') { const inner = [...scopes, declaredIn(n.body, n.params)]; visit(n.body, inner); return; }
      if (n.k === 'assign' && n.target.k === 'id') { const name = n.target.name; if (!KNOWN_INPUTS.has(name) && !scopes.some(sc => sc.has(name))) out.add(name); }
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v, scopes);
  };
  visit(program, [declaredIn(program, [])]);
  return out;
}

/** Read a script without running it. Throws `ScriptSyntaxError` with where it went wrong. */
export function analyze(text: string): Analysis {
  try { return analyzeOnce(text); }
  catch (e) {
    // A script nested so deeply that reading it would overflow the stack is refused, wherever it is read (the page reads scripts too).
    if (e instanceof RangeError) throw new ScriptSyntaxError({ code: 'too-deep', line: 0, col: 0 });
    throw e;
  }
}
function analyzeOnce(text: string): Analysis {
  const program = parse(text);
  const declared = declaredNames(program);
  const persistent = persistentNames(program), options: OptionDecl[] = [], read = new Set<string>(), warnings: Warning[] = [];
  const sourceCalls: Extract<Expr, { k: 'call' }>[] = [], inputs = new Set<string>();
  const optionNames = new Set<string>();
  const visit = (node: unknown, top: boolean): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) visit(x, top); return; }
    const n = node as Expr | Stmt;
    if ('k' in n) {
      if (n.k === 'member' && n.obj.k === 'id' && n.obj.name === 'options') read.add(n.name);
      if (n.k === 'call' && n.callee.k === 'id' && n.callee.name === 'source') sourceCalls.push(n);
      if (n.k === 'id' && (n.name === 'vbuy' || n.name === 'vsell' || n.name === 'lbuy' || n.name === 'lsell' || n.name === 'cbuy' || n.name === 'csell')) inputs.add(n.name);
      if (n.k === 'id' && n.name === 'oichg' && !persistent.has('oichg') && !declared.has('oichg')) inputs.add('oichg');
      // The order book (version 3 names), called or only named (kept under another name, handed to a function): the page then loads it. A
      // name declared somewhere (a parameter, a function of the script's own) may still mean the page's elsewhere, so only one the script
      // keeps from candle to candle (one name everywhere) is taken for its own.
      if (n.k === 'id' && DEPTH_FUNCTIONS.has(n.name) && !persistent.has(n.name)) inputs.add('depth');
      // The flow read through `bar`: the page then fills the candles it did not record from the chart market's own. The liquidations read
      // through it: the page then loads their days (it loads them only for a script that reads them).
      if (n.k === 'member' && n.obj.k === 'id' && n.obj.name === 'bar' && (n.name === 'vbuy' || n.name === 'vsell' || n.name === 'recorded' || n.name === 'lbuy' || n.name === 'lsell')) inputs.add(n.name);
      // `bar` read any way but as `bar.name` with another name (bar["oichg"], kept under another name, handed to a function) may read the
      // change in open interest, the flow or the liquidations: the page then works them out.
      if (n.k === 'id' && n.name === 'bar') bars++;
      if (n.k === 'member' && n.obj.k === 'id' && n.obj.name === 'bar' && n.name !== 'oichg') plainBars++;
      if (n.k === 'assign' && n.target.k === 'id' && n.value.k === 'call' && n.value.callee.k === 'id' && n.value.callee.name === 'option') {
        const name = n.target.name;
        if (!optionNames.has(name)) { optionNames.add(name); options.push(optionDecl(name, n.value)); }
      }
      if (n.k === 'decl') for (const d of n.items) if (d.init?.k === 'call' && d.init.callee.k === 'id' && d.init.callee.name === 'option' && !optionNames.has(d.name)) { optionNames.add(d.name); options.push(optionDecl(d.name, d.init)); }
      if (n.k === 'member' && n.obj.k === 'id' && n.obj.name === 'renderer' && !RENDERER_MEMBERS.has(n.name)) warnings.push({ code: 'unsupported-member', detail: `renderer.${n.name}` });
      if (n.k === 'member' && n.obj.k === 'id' && n.obj.name === 'theme' && !persistent.has('theme') && !declared.has('theme') && !THEME_MEMBERS.has(n.name)) warnings.push({ code: 'unsupported-member', detail: `theme.${n.name}` });
      if (n.k === 'id' && n.name.startsWith('$') && n.name !== '$price') warnings.push({ code: 'unknown-reference', detail: n.name });
      if (n.k === 'id' && (n.name === 'cbuy' || n.name === 'csell') && !warnings.some(w => w.code === 'no-counts')) warnings.push({ code: 'no-counts' });
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v, false);
  };
  let bars = 0, plainBars = 0;
  visit(program, true);
  // 'bar' marks it for what else it may read (the liquidations' days are loaded for it), not as a read of lbuy itself (no missing-rows warning).
  if (bars > plainBars && !declared.has('bar') && !persistent.has('bar')) { inputs.add('oichg'); inputs.add('vbuy'); inputs.add('bar'); }
  // What only a full browser engine has (the chart library's series objects, the raw function library): refused with where it is used.
  const refuse = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(refuse); return; }
    const x = node as Expr;
    if ('k' in x && x.k === 'id' && (x.name === 'series' || x.name === 'utils' || x.name === 'vars') && !declared.has(x.name) && !persistent.has(x.name)) throw new ScriptSyntaxError({ code: 'unsupported', line: x.p.line, col: x.p.col, detail: x.name });
    for (const v of Object.values(x)) if (v && typeof v === 'object') refuse(v);
  };
  refuse(program);
  const a = { program, persistent, sourceCalls, inputs, declared: options, read: [...read].filter(n => !optionNames.has(n)), warnings: dedupe(warnings), sources: new Map<string, SourceFilter>() };
  a.sources = sourcesWith(a, {});
  if (a.sources.size > MAX_SOURCES) { const c = sourceCalls[sourceCalls.length - 1]!; throw new ScriptSyntaxError({ code: 'too-many-sources', line: c.p.line, col: c.p.col }); }
  return a;
}

const dedupe = (w: Warning[]): Warning[] => w.filter((x, i) => w.findIndex(y => y.code === x.code && y.detail === x.detail) === i);

function optionDecl(name: string, call: Extract<Expr, { k: 'call' }>): OptionDecl {
  const arg = (k: string): OptionValue | undefined => { const n = call.named.find(x => x.name === k); return n ? literal(n.value) : undefined; };
  const def = arg('default') ?? (call.args[0] ? literal(call.args[0]) : undefined);
  const t = String(arg('type') ?? '').toLowerCase();
  const type: OptionDecl['type'] = t === 'color' ? 'color' : t === 'checkbox' || t === 'boolean' || t === 'bool' || typeof def === 'boolean' ? 'boolean' : t === 'list' ? 'list' : t === 'range' ? 'range' : t === 'text' || t === 'string' || (typeof def === 'string' && !/^(#|rgb|hsl)/i.test(def)) ? 'text' : typeof def === 'string' ? 'color' : 'number';
  // A default that is missing or false-like (0, false, '') is '' for a text, false for a switch, and the minimum (never under 0) for a number.
  const min = arg('min');
  const decl: OptionDecl = { name, type, value: def || (type === 'boolean' ? false : type === 'text' || type === 'color' || type === 'list' ? '' : Math.max(typeof min === 'number' ? min : 0, 0)) };
  const label = arg('label'); if (typeof label === 'string') decl.label = label;
  for (const k of ['min', 'max', 'step'] as const) { const v = arg(k); if (typeof v === 'number') decl[k] = v; }
  const choices = arg('options'); if (Array.isArray(choices)) decl.choices = choices;
  return decl;
}
