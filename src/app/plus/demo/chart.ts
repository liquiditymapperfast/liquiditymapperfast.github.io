/**
 * The demo's chart, in SVG (about a hundred elements, made once per size; a frame only rewrites the paths and words that changed): the
 * price trace up to the live edge, the levels as lines right of it, the liquidation column (each price's bars, the running total as a curve,
 * take profits in a lane of their own or alone with a dashed curve), the price axis, and under it the Depth pane through the window with its
 * table, the free part of the history apart from the Plus part.
 */
import { t } from '../../i18n.ts';
import { PLUS_NAME } from '../name.ts';
import { BANDS, FREE_HH, HH, PMAX, PMIN, SNAP_HH, priceAt, type DemoData } from './data.ts';
import { DEMO_WIN, bucketsOf, depthColumns, depthTable, emptyLevels, levelsAt, strengthOf, type Bucket, type Levels, type Weights } from './model.ts';
import { add, bandLabel, dayLabel, money, priceText, sv, text, timeLabel } from './svg.ts';

/** The chart's height for its width: 320 px on a phone (the chart itself under 420 px), else 372. */
export const chartHeight = (w: number): number => w < 420 ? 320 : 372;

export interface Layout {
  W: number; H: number; phone: boolean;
  axisW: number; colW: number; laneW: number; mainW: number;
  xAxis: number; xCol: number; xLane: number; xLive: number; padL: number;
  top: number; capY: number; depthTop: number; depthBottom: number; chartBottom: number;
  bk: Bucket[];
  /** Per bucket: its top and bottom, its middle, and the thickness of its bar. */
  y0: Float64Array; y1: Float64Array; yc: Float64Array; bt: Float64Array;
  yOf(p: number): number;
}

export function layoutFor(W: number): Layout {
  const H = chartHeight(W), phone = W < 420;
  const axisW = phone ? 46 : 60, colW = phone ? Math.max(100, Math.round(W * 0.29)) : 150;
  const laneW = phone ? 24 : Math.round(colW * 0.24);
  const xAxis = W - axisW, xCol = xAxis - colW, mainW = colW - laneW - 4, xLane = xCol + mainW + 4;
  const xLive = xCol - Math.round(xCol * (phone ? 0.42 : 0.4)), padL = phone ? 6 : 10;
  const top = phone ? 34 : 38, capY = 13, dateH = 16, depthH = phone ? 66 : 84;
  const depthBottom = H - dateH, depthTop = depthBottom - depthH, chartBottom = depthTop - (phone ? 20 : 24);
  const yOf = (p: number): number => top + (PMAX - p) / (PMAX - PMIN) * (chartBottom - top);
  const bk = bucketsOf(phone ? 2 : 1), n = bk.length;
  const y0 = new Float64Array(n), y1 = new Float64Array(n), yc = new Float64Array(n), bt = new Float64Array(n);
  bk.forEach((b, i) => { y0[i] = yOf(b.hi); y1[i] = yOf(b.lo); yc[i] = (y0[i]! + y1[i]!) / 2; bt[i] = Math.max(1.4, Math.min(7, (y1[i]! - y0[i]!) * 0.62)); });
  return { W, H, phone, axisW, colW, laneW, mainW, xAxis, xCol, xLane, xLive, padL, top, capY, depthTop, depthBottom, chartBottom, bk, y0, y1, yc, bt, yOf };
}

export interface Chart {
  readonly svg: SVGSVGElement;
  readonly layout: Layout | null;
  /** Lay the chart out for a width (nothing when it is the same); whether it changed. */
  resize(width: number): boolean;
  /** Draw `w`'s layers of `data` for the window ending at half hour `end`. */
  draw(data: DemoData, w: Weights, end: number): void;
}

const f1 = (v: number): string => v.toFixed(1);

export function createChart(): Chart {
  const svg = sv('svg', { class: 'pd-ch', role: 'img', 'aria-label': t('Illustrative chart of the levels') });
  let laid: Layout | null = null, V: Levels = emptyLevels(0);
  // What a frame rewrites, kept from the last build.
  let built: ReturnType<typeof build> | null = null;
  const words = new WeakMap<Element, string>();
  /** Write `s` into `node` when it says something else; whether it changed. */
  const say = (node: Element, s: string): boolean => { if (words.get(node) === s) return false; node.textContent = s; words.set(node, s); return true; };
  const put = (node: Element, k: string, v: string | number): void => { const s = String(v); if (node.getAttribute(k) !== s) node.setAttribute(k, s); };
  const op = (node: SVGElement, v: number): void => { const s = v <= 0.001 ? '0' : v >= 0.999 ? '1' : v.toFixed(3); if (node.style.opacity !== s) node.style.opacity = s; };
  const show = (node: SVGElement, on: boolean): void => { const s = on ? '' : 'none'; if (node.style.display !== s) node.style.display = s; };

  function build(L: Layout) {
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${L.W} ${L.H}`); svg.setAttribute('width', String(L.W)); svg.setAttribute('height', String(L.H));
    // The price grid and its axis.
    const stepP = L.phone ? 4000 : 2000, axis: [number, number][] = [];
    let grid = '';
    for (let p = Math.ceil(PMIN / stepP) * stepP; p <= PMAX; p += stepP) { const y = Math.round(L.yOf(p)) + 0.5; grid += `M0,${y}H${L.xAxis}`; axis.push([p, y]); }
    add(svg, 'path', { class: 'pd-grid', d: grid });
    // The Depth pane through the window, its table right of it.
    const dg = add(svg, 'g');
    const dPlus = add(dg, 'rect', { class: 'pd-d-plus', y: L.depthTop, height: L.depthBottom - L.depthTop, x: L.padL, width: 0 });
    const dbUp: SVGPathElement[] = [], dbDn: SVGPathElement[] = [];
    for (let k = BANDS.length - 1; k >= 0; k--) { dbUp[k] = add(dg, 'path', { class: `pd-db pd-up pd-k${k}` }); dbDn[k] = add(dg, 'path', { class: `pd-db pd-dn pd-k${k}` }); }
    const dEdgeUp = add(dg, 'path', { class: 'pd-d-edge pd-up' }), dEdgeDn = add(dg, 'path', { class: 'pd-d-edge pd-dn' });
    const dTp = add(dg, 'g');
    const dTpcU = add(dTp, 'path', { class: 'pd-d-tpc' }), dTpcD = add(dTp, 'path', { class: 'pd-d-tpc' });
    const dTpU = add(dTp, 'path', { class: 'pd-d-tp' }), dTpD = add(dTp, 'path', { class: 'pd-d-tp' });
    const mid = Math.round((L.depthTop + L.depthBottom) / 2) + 0.5;
    add(dg, 'line', { class: 'pd-d-zero', x1: L.padL, x2: L.xLive, y1: mid, y2: mid });
    add(dg, 'rect', { class: 'pd-d-bg', x: L.padL + 0.5, y: L.depthTop + 0.5, width: L.xLive - L.padL - 1, height: L.depthBottom - L.depthTop - 1 });
    const dBnd = add(dg, 'line', { class: 'pd-d-bnd', y1: L.depthTop, y2: L.depthBottom });
    const dRegPlus = text(dg, PLUS_NAME, { class: 'pd-d-reg', y: L.depthTop + 13, 'text-anchor': 'end' });
    const dRegFree = text(dg, t('Free'), { class: 'pd-d-reg pd-free', y: L.depthTop + 13, 'text-anchor': 'start' });
    text(dg, t('Depth'), { class: 'pd-d-title', x: L.padL, y: L.depthTop - 6 });
    const dDates = (['start', 'middle', 'end'] as const).map(anchor => add(dg, 'text', { y: L.depthBottom + 12, 'text-anchor': anchor }));
    const tx0 = L.xLive + (L.phone ? 8 : 14), tx2 = L.xAxis - 6, tx1 = tx0 + (tx2 - tx0) * (L.phone ? 0.6 : 0.58);
    const rowH = Math.min(13, (L.depthBottom - L.depthTop - 4) / 6);
    text(dg, t('Shorts'), { class: 'pd-t-head pd-t-up', x: tx1, y: L.depthTop + rowH - 1, 'text-anchor': 'end' });
    text(dg, t('Longs'), { class: 'pd-t-head pd-t-dn', x: tx2, y: L.depthTop + rowH - 1, 'text-anchor': 'end' });
    const cells: [SVGTextElement, SVGTextElement][] = [];
    BANDS.forEach((pct, k) => {
      const y = L.depthTop + rowH * (k + 2) - 1;
      text(dg, bandLabel(pct), { x: tx0, y });
      cells.push([add(dg, 'text', { class: 'pd-t-cell', x: tx1, y, 'text-anchor': 'end' }), add(dg, 'text', { class: 'pd-t-cell', x: tx2, y, 'text-anchor': 'end' })]);
    });
    // The trace up to the live edge.
    const traceArea = add(svg, 'path', { class: 'pd-trace-area' }), trace = add(svg, 'path', { class: 'pd-trace' });
    // The level lines right of the live edge: one path per kind, side and strength (take profits dashed, in the other side's colour).
    const kinds = (['liq', 'stop', 'tp'] as const).map(kind => {
      const g = add(svg, 'g'), ln: SVGPathElement[][] = [[], []], mk: SVGPathElement[] = [];
      for (const side of [0, 1]) {
        const cls = (kind === 'tp') === (side === 0) ? 'pd-a' : 'pd-b';
        for (let l = 0; l < 3; l++) ln[side]![l] = add(g, 'path', { class: `pd-ln ${cls} pd-l${l}${kind === 'tp' ? ' pd-dash' : ''}` });
        if (kind !== 'tp') mk[side] = add(g, 'path', { class: `pd-mk ${cls}` });
      }
      return { kind, g, ln, mk };
    });
    // The column: the running total behind each price's bars, take profits in their own lane.
    const colG = add(svg, 'g');
    add(colG, 'rect', { class: 'pd-col-bg', x: L.xCol, y: L.top - 4, width: L.colW, height: L.chartBottom - L.top + 4 });
    const cumfU = add(colG, 'path', { class: 'pd-cumf pd-b' }), cumfD = add(colG, 'path', { class: 'pd-cumf pd-a' });
    const barLU = add(colG, 'path', { class: 'pd-bar pd-b' }), barLD = add(colG, 'path', { class: 'pd-bar pd-a' });
    const barSU = add(colG, 'path', { class: 'pd-bar pd-stop pd-b' }), barSD = add(colG, 'path', { class: 'pd-bar pd-stop pd-a' });
    const cumlU = add(colG, 'path', { class: 'pd-cuml pd-b' }), cumlD = add(colG, 'path', { class: 'pd-cuml pd-a' });
    const tpBars = add(colG, 'g');
    const tpbU = add(tpBars, 'path', { class: 'pd-tpb pd-a' }), tpbD = add(tpBars, 'path', { class: 'pd-tpb pd-b' });
    const tpcU = add(colG, 'path', { class: 'pd-tpc pd-a' }), tpcD = add(colG, 'path', { class: 'pd-tpc pd-b' });
    const laneSep = add(colG, 'line', { class: 'pd-lane-sep', x1: L.xLane - 1.5, x2: L.xLane - 1.5, y1: L.top, y2: L.chartBottom });
    const capLevel = add(colG, 'text', { class: 'pd-cap', x: L.xCol + 4, y: L.capY }), capCum = add(colG, 'text', { class: 'pd-cap', x: L.xCol + 4, y: L.capY + 12 });
    const edge = add(svg, 'line', { class: 'pd-edge', y1: L.top - 2, y2: L.chartBottom });
    const priceLine = add(svg, 'line', { class: 'pd-pline' });
    const dot = add(svg, 'circle', { class: 'pd-dot', r: 3.5 });
    const edgeLab = add(svg, 'text', { class: 'pd-edge-lab', 'text-anchor': 'middle', y: L.top - 8 });
    const axisT = axis.map(([p, y]) => text(svg, priceText(p), { x: L.xAxis + 6, y: y + 3.5 }));
    const tagBg = add(svg, 'rect', { class: 'pd-tag-bg', x: L.xAxis + 2, width: L.axisW - 4, height: 16, rx: 2 });
    const tagTx = add(svg, 'text', { class: 'pd-tag-tx', x: L.xAxis + L.axisW / 2, 'text-anchor': 'middle' });
    return { endsMeasured: false, axis, dPlus, dbUp, dbDn, dEdgeUp, dEdgeDn, dTp, dTpcU, dTpcD, dTpU, dTpD, dBnd, dRegPlus, dRegFree, dDates, cells, traceArea, trace, kinds, colG,
      cumfU, cumfD, barLU, barLD, barSU, barSD, cumlU, cumlD, tpBars, tpbU, tpbD, tpcU, tpcD, laneSep, capLevel, capCum, edge, priceLine, dot, edgeLab, axisT, tagBg, tagTx };
  }

  /** A running total as a step line out from the price (`dir` 1 upwards, -1 downwards), closed back to the column's edge for a fill. */
  function stepPath(L: Layout, arr: Float64Array, from: number, to: number, dir: 1 | -1, x0: number, scale: number, yP: number, fill: boolean): string {
    let d = `M${x0},${f1(yP)}`, lastY = yP;
    for (let b = from; dir > 0 ? b <= to : b >= to; b += dir) {
      const x = f1(x0 + arr[b]! * scale);
      const yIn = dir > 0 ? Math.min(lastY, L.y1[b]!) : Math.max(lastY, L.y0[b]!), yOut = dir > 0 ? L.y0[b]! : L.y1[b]!;
      d += `L${x},${f1(yIn)}L${x},${f1(yOut)}`;
      lastY = yOut;
    }
    return fill ? `${d}L${x0},${f1(lastY)}Z` : d;
  }

  function draw(data: DemoData, w: Weights, end: number): void {
    const L = laid, E = built;
    if (!L || !E) return;
    const n = L.bk.length, start = end - DEMO_WIN;
    V = levelsAt(data, L.bk, end, w, V.lS.length === n ? V : emptyLevels(n));
    const P = V.price, yP = L.yOf(P), live = end >= HH - 1.01, pb = V.pb;
    // ---- the level lines
    const xa = L.xLive + 1, xb = L.xCol - 1;
    const paths = { liq: [['', '', ''], ['', '', '']], stop: [['', '', ''], ['', '', '']], tp: [['', '', ''], ['', '', '']] };
    const marks = { liq: ['', ''], stop: ['', ''] };
    const dotAt = (x: number, y: number): string => `M${f1(x - 1.9)},${y}a1.9,1.9 0 1 0 3.8,0a1.9,1.9 0 1 0 -3.8,0`;
    const squareAt = (x: number, y: number): string => `M${f1(x - 2)},${y - 2}h4v4h-4z`;
    for (let b = 0; b < n; b++) {
      const y = Math.round(L.yc[b]!) + 0.5;
      const items: readonly ['liq' | 'stop' | 'tp', 0 | 1, number][] = [['liq', 0, V.lS[b]!], ['liq', 1, V.lL[b]!], ['stop', 0, V.sS[b]!], ['stop', 1, V.sL[b]!], ['tp', 0, V.tL[b]!], ['tp', 1, V.tS[b]!]];
      for (const [kind, side, a] of items) {
        const l = strengthOf(a / V.levelRef);
        if (l < 0) continue;
        paths[kind][side]![l] += `M${xa},${y}H${xb}`;
        if (l === 0 && kind !== 'tp') { const m = kind === 'liq' ? dotAt : squareAt; marks[kind][side] += m(xa + 3, y) + m(xb - 3, y); }
      }
    }
    for (const set of E.kinds) {
      for (const side of [0, 1] as const) {
        for (let l = 0; l < 3; l++) put(set.ln[side]![l]!, 'd', paths[set.kind][side]![l] || 'M0,0');
        if (set.kind !== 'tp') put(set.mk[side]!, 'd', marks[set.kind][side] || 'M0,0');
      }
      op(set.g, set.kind === 'liq' ? w.liq : set.kind === 'stop' ? w.stop : w.tp);
    }
    // ---- the column
    const bx = L.xCol + 1, bmax = L.mainW * 0.5, sc = bmax / V.levelMax, lx = L.xLane + 1, lmax = L.laneW - 4;
    let dLU = '', dLD = '', dSU = '', dSD = '', dTU = '', dTD = '';
    const tl = w.tp * (1 - w.alone), ta = w.alone;
    for (let b = 0; b < n; b++) {
      const bt = L.bt[b]!, y = f1(L.yc[b]! - bt / 2), yc = Math.round(L.yc[b]!) + 0.5;
      const rect = (x: number, len: number): string => `M${f1(x)},${y}h${f1(len)}v${f1(bt)}h${f1(-len)}z`;
      const u1 = w.liq * V.lS[b]! * sc, u2 = w.stop * V.sS[b]! * sc, d1 = w.liq * V.lL[b]! * sc, d2 = w.stop * V.sL[b]! * sc;
      if (u1 > 0.3) dLU += rect(bx, u1);
      if (u2 > 0.3) dSU += rect(bx + u1, u2);
      if (d1 > 0.3) dLD += rect(bx, d1);
      if (d2 > 0.3) dSD += rect(bx + d1, d2);
      // Take profits: dashed bars in their lane on the same dollar scale, or in the main lane when they are alone.
      const tU = V.tL[b]! * sc, tD = V.tS[b]! * sc;
      if (tl > 0.01) { const a = Math.min(lmax, tU * tl), c = Math.min(lmax, tD * tl); if (a > 0.6) dTU += `M${lx},${yc}h${f1(a)}`; if (c > 0.6) dTD += `M${lx},${yc}h${f1(c)}`; }
      if (ta > 0.01) { const a = Math.min(bmax, tU * ta), c = Math.min(bmax, tD * ta); if (a > 0.6) dTU += `M${bx},${yc}h${f1(a)}`; if (c > 0.6) dTD += `M${bx},${yc}h${f1(c)}`; }
    }
    put(E.barLU, 'd', dLU || 'M0,0'); put(E.barLD, 'd', dLD || 'M0,0'); put(E.barSU, 'd', dSU || 'M0,0'); put(E.barSD, 'd', dSD || 'M0,0');
    put(E.tpbU, 'd', dTU || 'M0,0'); put(E.tpbD, 'd', dTD || 'M0,0');
    op(E.tpBars, Math.max(w.tp, w.alone));
    const cx = L.xCol, cs = (L.mainW - 2) / V.cumMax, solid = Math.max(w.liq, w.stop);
    put(E.cumfU, 'd', stepPath(L, V.cU, pb, n - 1, 1, cx, cs, yP, true)); put(E.cumlU, 'd', stepPath(L, V.cU, pb, n - 1, 1, cx, cs, yP, false));
    put(E.cumfD, 'd', stepPath(L, V.cD, pb, 0, -1, cx, cs, yP, true)); put(E.cumlD, 'd', stepPath(L, V.cD, pb, 0, -1, cx, cs, yP, false));
    for (const node of [E.cumfU, E.cumfD, E.cumlU, E.cumlD]) op(node, solid);
    put(E.tpcU, 'd', stepPath(L, V.tU, pb, n - 1, 1, cx, cs, yP, false)); put(E.tpcD, 'd', stepPath(L, V.tD, pb, 0, -1, cx, cs, yP, false));
    op(E.tpcU, w.alone); op(E.tpcD, w.alone);
    op(E.laneSep, w.tp * (1 - w.alone));
    say(E.capLevel, t('LEVEL MAX {value}', { value: money(V.levelMax) }));
    say(E.capCum, t('CUM MAX {value}', { value: money(V.cumMax) }));
    // ---- the trace and the live edge
    const xs = (L.xLive - L.padL) / DEMO_WIN, X = (hh: number): number => L.padL + (hh - start) * xs;
    let dt = `M${L.padL},${f1(L.yOf(priceAt(data, start)))}`;
    for (let i = Math.ceil(start); i < end; i++) if (i >= 0) dt += `L${f1(X(i))},${f1(L.yOf(data.price[i]!))}`;
    dt += `L${L.xLive},${f1(yP)}`;
    put(E.trace, 'd', dt); put(E.traceArea, 'd', `${dt}L${L.xLive},${L.chartBottom}L${L.padL},${L.chartBottom}Z`);
    put(E.edge, 'x1', L.xLive + 0.5); put(E.edge, 'x2', L.xLive + 0.5);
    const yLine = Math.round(yP) + 0.5;
    put(E.priceLine, 'x1', L.xLive); put(E.priceLine, 'x2', L.xAxis); put(E.priceLine, 'y1', yLine); put(E.priceLine, 'y2', yLine);
    put(E.dot, 'cx', L.xLive); put(E.dot, 'cy', f1(yP)); put(E.dot, 'class', live ? 'pd-dot pd-live' : 'pd-dot');
    put(E.edgeLab, 'x', L.xLive); say(E.edgeLab, live ? t('Live') : timeLabel(end));
    put(E.tagBg, 'y', f1(yP - 8)); put(E.tagTx, 'y', f1(yP + 3.5)); say(E.tagTx, priceText(P));
    E.axisT.forEach((node, i) => op(node, Math.abs(E.axis[i]![1] - yP) < 12 ? 0 : 1));
    // ---- the Depth pane through the window
    const mid = (L.depthTop + L.depthBottom) / 2, half = (L.depthBottom - L.depthTop) / 2 - 3;
    const depth = depthColumns(data, start, end, w), cols = depth.cols.map(c => ({ ...c, xA: Math.max(L.padL, X(c.c * SNAP_HH)), xB: Math.min(L.xLive, X(c.c * SNAP_HH + SNAP_HH)) })).filter(c => c.xB - c.xA > 0.05);
    const yv = (v: number, s: number): string => f1(mid + s * v / depth.max * half);
    const area = (pick: (c: typeof cols[number]) => number, s: number): string => {
      if (!cols.length) return 'M0,0';
      let d = `M${f1(cols[0]!.xA)},${mid}`;
      for (const c of cols) { const y = yv(pick(c), s); d += `L${f1(c.xA)},${y}L${f1(c.xB)},${y}`; }
      return `${d}L${f1(cols[cols.length - 1]!.xB)},${mid}Z`;
    };
    const line = (pick: (c: typeof cols[number]) => number, s: number): string => {
      if (!cols.length) return 'M0,0';
      let d = '';
      cols.forEach((c, i) => { const y = yv(pick(c), s); d += `${i ? 'L' : 'M'}${f1(c.xA)},${y}L${f1(c.xB)},${y}`; });
      return d;
    };
    for (let k = 0; k < BANDS.length; k++) { put(E.dbUp[k]!, 'd', area(c => c.up[k]!, -1)); put(E.dbDn[k]!, 'd', area(c => c.dn[k]!, 1)); }
    const last = BANDS.length - 1;
    put(E.dEdgeUp, 'd', line(c => c.up[last]!, -1)); put(E.dEdgeDn, 'd', line(c => c.dn[last]!, 1));
    const tpu = line(c => c.tu, -1), tpd = line(c => c.td, 1);
    put(E.dTpcU, 'd', tpu); put(E.dTpU, 'd', tpu); put(E.dTpcD, 'd', tpd); put(E.dTpD, 'd', tpd);
    op(E.dTp, w.tp);
    op(E.dEdgeUp, solid); op(E.dEdgeDn, solid);
    // Where the free week starts: the Plus part of the window is tinted, a dashed line between, each part named where it has room.
    const xBnd = X(HH - 1 - FREE_HH), inside = xBnd > L.padL + 1 && xBnd < L.xLive - 1;
    put(E.dPlus, 'width', f1(Math.max(0, Math.max(L.padL, Math.min(L.xLive, xBnd)) - L.padL)));
    show(E.dBnd, inside);
    if (inside) { put(E.dBnd, 'x1', f1(xBnd)); put(E.dBnd, 'x2', f1(xBnd)); }
    show(E.dRegPlus, xBnd > L.padL + 30); show(E.dRegFree, xBnd < L.xLive - 30);
    put(E.dRegPlus, 'x', f1(Math.min(xBnd, L.xLive) - 5)); put(E.dRegFree, 'x', f1(Math.max(xBnd, L.padL) + 5));
    put(E.dDates[0]!, 'x', L.padL); put(E.dDates[1]!, 'x', f1((L.padL + L.xLive) / 2)); put(E.dDates[2]!, 'x', L.xLive);
    const firstDate = E.dDates[0]!, lastDate = E.dDates[2]!;
    const ends = say(firstDate, dayLabel(Math.max(0, start))); say(E.dDates[1]!, dayLabel(start + DEMO_WIN / 2));
    if (say(lastDate, live ? t('Now') : dayLabel(end)) || ends || !E.endsMeasured) {
      // A narrow strip's two ends, measured as written (only when their words change): where the first would run into the last ("11 nov."
      // into "Maintenant" on a 320 px phone), the last alone says where the window ends.
      E.endsMeasured = true;
      show(firstDate, true);
      const room = typeof firstDate.getComputedTextLength === 'function' ? L.xLive - L.padL - firstDate.getComputedTextLength() - lastDate.getComputedTextLength() : Infinity;
      show(firstDate, room >= 6);
    }
    // A phone's strip (about 100 px) has room for its two ends only: a date of the middle ran into the first ("11. Nov.15. Nov."). A wider
    // screen's (165 px and up) keeps all three, as the prototype had them.
    show(E.dDates[1]!, L.xLive - L.padL >= 150);
    const table = depthTable(data, end, w);
    E.cells.forEach(([up, dn], k) => { say(up, solid > 0.02 ? money(table.up[k]!) : '–'); say(dn, solid > 0.02 ? money(table.dn[k]!) : '–'); });
  }

  return {
    svg,
    get layout() { return laid; },
    resize(width) {
      const W = Math.round(width);
      if (W < 60 || (laid && laid.W === W)) return false;
      laid = layoutFor(W);
      built = build(laid);
      return true;
    },
    draw,
  };
}
