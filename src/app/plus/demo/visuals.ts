/**
 * The three pictures of Plus's features, for the Plus page and the presentation's feature sections, drawn from the demo's made-up numbers
 * and labelled so: the history (the whole of it with Plus, the last 7 days free), the three layers side by side, and everyone beside the
 * profitable traders on one dollar scale. Still pictures: nothing moves, nothing is timed.
 */
import { t } from '../../i18n.ts';
import { PLUS_NAME } from '../name.ts';
import { FREE_HH, HH, LIQ, ROW0, ROW_STEP, ROWS, SNAPS, STOP, bandIndex, whenData, type DemoData } from './data.ts';
import { add, dayLabel, money, sv, text } from './svg.ts';

export interface VisualHosts { history?: HTMLElement | null; layers?: HTMLElement | null; groups?: HTMLElement | null }

const f1 = (v: number): string => v.toFixed(1);

function historyPicture(s: SVGSVGElement, d: DemoData): void {
  const Wv = 400, Hv = 150, x0 = 4, x1 = Wv - 4, ww = x1 - x0, mid = 52, half = 40;
  const last = 4, up: number[] = [], dn: number[] = [];
  let max = 1;
  for (let c = 0; c < SNAPS; c += 2) {
    const u = d.band[bandIndex(c, 0, LIQ, 0, last)]! + d.band[bandIndex(c, 0, STOP, 0, last)]!, w = d.band[bandIndex(c, 0, LIQ, 1, last)]! + d.band[bandIndex(c, 0, STOP, 1, last)]!;
    up.push(u); dn.push(w); max = Math.max(max, u, w);
  }
  const step = ww / up.length;
  const area = (arr: number[], sign: number): string => {
    let p = `M${x0},${mid}`;
    arr.forEach((v, i) => { const y = f1(mid + sign * v / max * half); p += `L${f1(x0 + i * step)},${y}L${f1(x0 + (i + 1) * step)},${y}`; });
    return `${p}L${x1},${mid}Z`;
  };
  add(s, 'path', { d: area(up, -1), class: 'pd-v-up' }); add(s, 'path', { d: area(dn, 1), class: 'pd-v-dn' });
  add(s, 'line', { x1: x0, x2: x1, y1: mid + 0.5, y2: mid + 0.5, class: 'pd-v-mid' });
  const xB = x0 + ww * (HH - FREE_HH) / HH, ty = 104, th = 20;
  add(s, 'rect', { x: x0, y: ty, width: xB - x0, height: th, rx: 3, class: 'pd-v-plus' });
  add(s, 'rect', { x: xB, y: ty, width: x1 - xB, height: th, rx: 3, class: 'pd-v-free' });
  text(s, PLUS_NAME, { x: (x0 + xB) / 2, y: ty + 14, 'text-anchor': 'middle', class: 'pd-v-seg pd-v-seg-plus' });
  text(s, t('Free'), { x: (xB + x1) / 2, y: ty + 14, 'text-anchor': 'middle', class: 'pd-v-seg' });
  add(s, 'line', { x1: xB, x2: xB, y1: 6, y2: ty + th + 4, class: 'pd-v-bnd' });
  text(s, dayLabel(0), { x: x0, y: Hv - 4, 'text-anchor': 'start' });
  text(s, dayLabel(HH - FREE_HH), { x: xB, y: Hv - 4, 'text-anchor': 'middle' });
  text(s, t('Today'), { x: x1, y: Hv - 4, 'text-anchor': 'end' });
}

/** The rows within 9 % of the price at the last snapshot, two to a bucket, with their top and bottom on a picture of `top` to `bottom`. */
function bucketsNow(d: DemoData, top: number, bottom: number): { yP: number; rows: { r: number; r1: number; y0: number; y1: number }[] } {
  const P = d.price[HH - 1]!, lo = P * 0.91, hi = P * 1.09, yOf = (p: number): number => top + (hi - p) / (hi - lo) * (bottom - top);
  const rA = Math.ceil((lo - ROW0) / ROW_STEP), rB = Math.floor((hi - ROW0) / ROW_STEP) - 1, rows: { r: number; r1: number; y0: number; y1: number }[] = [];
  for (let r = rA; r <= rB; r += 2) { const r1 = Math.min(r + 1, rB); rows.push({ r, r1, y0: yOf(ROW0 + (r1 + 1) * ROW_STEP), y1: yOf(ROW0 + r * ROW_STEP) }); }
  return { yP: yOf(P), rows };
}

function layersPicture(s: SVGSVGElement, d: DemoData): void {
  const pw = 120, gap = 20, top = 24, bottom = 150, c = SNAPS - 1;
  const { yP, rows } = bucketsNow(d, top, bottom);
  const specs = [
    { title: t('Liquidations'), up: d.liqS, dn: d.liqL, marker: 'dot', tp: false },
    { title: t('Stops'), up: d.stopS, dn: d.stopL, marker: 'square', tp: false },
    { title: t('Take profits'), up: d.tpL, dn: d.tpS, marker: '', tp: true },
  ] as const;
  specs.forEach((spec, k) => {
    const ox = k * (pw + gap);
    text(s, spec.title, { x: ox, y: 13, class: 'pd-v-title' });
    add(s, 'rect', { x: ox + 0.5, y: top + 0.5, width: pw - 1, height: bottom - top - 1, class: 'pd-v-frame' });
    const buckets = rows.map(b => { let u = 0, w = 0; for (let j = b.r; j <= b.r1; j++) { u += spec.up[c * ROWS + j]!; w += spec.dn[c * ROWS + j]!; } return { ...b, u, d: w }; });
    let bmax = 1;
    for (const b of buckets) bmax = Math.max(bmax, b.u, b.d);
    const upCls = spec.tp ? 'pd-a' : 'pd-b', dnCls = spec.tp ? 'pd-b' : 'pd-a';
    const above = buckets.filter(b => b.y1 <= yP + 0.1), below = buckets.filter(b => b.y0 >= yP - 0.1).reverse();
    let totU = 0, totD = 0;
    for (const b of above) totU += b.u;
    for (const b of below) totD += b.d;
    const cmax = Math.max(totU, totD, 1), cw = pw - 6, bw = (pw - 6) * 0.45;
    const bar = (b: { y0: number; y1: number }, v: number): [string, string] => {
      const len = v / bmax * bw, yc = (b.y0 + b.y1) / 2;
      if (len < 0.5) return ['', ''];
      const path = spec.tp ? `M${ox + 1},${f1(yc)}h${f1(len)}` : `M${ox + 1},${f1(yc - 1.6)}h${f1(len)}v3.2h${f1(-len)}z`;
      let m = '';
      if (spec.marker && v / bmax > 0.4) { const x = ox + 1 + len + 3; m = spec.marker === 'dot' ? `M${f1(x - 2)},${f1(yc)}a2,2 0 1 0 4,0a2,2 0 1 0 -4,0` : `M${f1(x - 2)},${f1(yc - 2)}h4v4h-4z`; }
      return [path, m];
    };
    let dU = '', dD = '', mU = '', mD = '', cumU = 0, cumD = 0, cU = `M${ox},${f1(yP)}`, cD = cU;
    for (const b of above) { const [p, m] = bar(b, b.u); dU += p; mU += m; cumU += b.u; const x = f1(ox + cumU / cmax * cw); cU += `L${x},${f1(Math.min(yP, b.y1))}L${x},${f1(b.y0)}`; }
    for (const b of below) { const [p, m] = bar(b, b.d); dD += p; mD += m; cumD += b.d; const x = f1(ox + cumD / cmax * cw); cD += `L${x},${f1(Math.max(yP, b.y0))}L${x},${f1(b.y1)}`; }
    const barCls = spec.tp ? 'pd-tpb' : spec.marker === 'square' ? 'pd-bar pd-stop' : 'pd-bar';
    add(s, 'path', { d: dU || 'M0,0', class: `${barCls} ${upCls}` }); add(s, 'path', { d: dD || 'M0,0', class: `${barCls} ${dnCls}` });
    if (spec.marker) { add(s, 'path', { d: mU || 'M0,0', class: `pd-mk ${upCls}` }); add(s, 'path', { d: mD || 'M0,0', class: `pd-mk ${dnCls}` }); }
    const curve = spec.tp ? 'pd-tpc' : 'pd-cuml';
    add(s, 'path', { d: cU, class: `${curve} ${upCls}` }); add(s, 'path', { d: cD, class: `${curve} ${dnCls}` });
    add(s, 'line', { x1: ox, x2: ox + pw, y1: Math.round(yP) + 0.5, y2: Math.round(yP) + 0.5, class: 'pd-v-price' });
  });
}

function groupsPicture(s: SVGSVGElement, d: DemoData): void {
  // Two precise views of the same moment on one dollar scale: everyone's liquidations and stops, and the profitable traders' own.
  const pw = 186, gap = 28, top = 34, bottom = 172, c = SNAPS - 1;
  const { yP, rows } = bucketsNow(d, top, bottom);
  const groups = [{ title: t('Everyone'), g: 0 }, { title: t('Profitable'), g: 1 }].map(({ title, g }) => {
    const parts = rows.map(b => {
      let lu = 0, su = 0, ld = 0, sd = 0;
      for (let j = b.r; j <= b.r1; j++) { const i = c * ROWS + j, kl = g ? d.pfLiq[i]! : 1, ks = g ? d.pfStop[i]! : 1; lu += d.liqS[i]! * kl; su += d.stopS[i]! * ks; ld += d.liqL[i]! * kl; sd += d.stopL[i]! * ks; }
      return { ...b, lu, su, ld, sd };
    });
    let up = 0, dn = 0;
    for (const b of parts) { if (b.y1 <= yP + 0.1) up += b.lu + b.su; if (b.y0 >= yP - 0.1) dn += b.ld + b.sd; }
    return { title, parts, up, dn };
  });
  let bmax = 1, cmax = 1;
  for (const gr of groups) { for (const b of gr.parts) bmax = Math.max(bmax, b.lu + b.su, b.ld + b.sd); cmax = Math.max(cmax, gr.up, gr.dn); }
  const bar = (x: number, b: { y0: number; y1: number }, len: number): string => len < 0.4 ? '' : `M${f1(x)},${f1((b.y0 + b.y1) / 2 - 1.6)}h${f1(len)}v3.2h${f1(-len)}z`;
  groups.forEach((gr, k) => {
    const ox = k * (pw + gap), bw = pw * 0.42, cw = pw - 4;
    text(s, gr.title, { x: ox, y: 12, class: 'pd-v-title' });
    text(s, t('CUM MAX {value}', { value: money(Math.max(gr.up, gr.dn)) }), { x: ox, y: 26, class: 'pd-cap' });
    add(s, 'rect', { x: ox + 0.5, y: top + 0.5, width: pw - 1, height: bottom - top - 1, class: 'pd-v-frame' });
    let lU = '', sU = '', lD = '', sD = '', run = 0, lastY = yP, cU = `M${ox},${f1(yP)}`, cD = cU;
    for (const b of gr.parts.filter(b => b.y1 <= yP + 0.1)) {
      const a = b.lu / bmax * bw, z = b.su / bmax * bw; lU += bar(ox + 1, b, a); sU += bar(ox + 1 + a, b, z);
      run += b.lu + b.su; const x = f1(ox + run / cmax * cw); cU += `L${x},${f1(Math.min(lastY, b.y1))}L${x},${f1(b.y0)}`; lastY = b.y0;
    }
    const fU = `${cU}L${ox},${f1(lastY)}Z`;
    run = 0; lastY = yP;
    for (const b of gr.parts.filter(b => b.y0 >= yP - 0.1).reverse()) {
      const a = b.ld / bmax * bw, z = b.sd / bmax * bw; lD += bar(ox + 1, b, a); sD += bar(ox + 1 + a, b, z);
      run += b.ld + b.sd; const x = f1(ox + run / cmax * cw); cD += `L${x},${f1(Math.max(lastY, b.y0))}L${x},${f1(b.y1)}`; lastY = b.y1;
    }
    const fD = `${cD}L${ox},${f1(lastY)}Z`;
    add(s, 'path', { d: fU, class: 'pd-cumf pd-b' }); add(s, 'path', { d: fD, class: 'pd-cumf pd-a' });
    add(s, 'path', { d: lU || 'M0,0', class: 'pd-bar pd-b' }); add(s, 'path', { d: sU || 'M0,0', class: 'pd-bar pd-stop pd-b' });
    add(s, 'path', { d: lD || 'M0,0', class: 'pd-bar pd-a' }); add(s, 'path', { d: sD || 'M0,0', class: 'pd-bar pd-stop pd-a' });
    add(s, 'path', { d: cU, class: 'pd-cuml pd-b' }); add(s, 'path', { d: cD, class: 'pd-cuml pd-a' });
    add(s, 'line', { x1: ox, x2: ox + pw, y1: Math.round(yP) + 0.5, y2: Math.round(yP) + 0.5, class: 'pd-v-price' });
  });
}

/** Each picture's frame (its size, so its room is kept before it is drawn), its name for a screen reader, and its drawing. */
const PICTURES = {
  history: { h: 150, cls: 'pd-vis', name: () => t('Timeline: the whole history with Plus, the last 7 days free'), draw: historyPicture },
  layers: { h: 156, cls: 'pd-vis pd-ch', name: () => t('Liquidations, stops and take profits as three separate layers'), draw: layersPicture },
  groups: { h: 178, cls: 'pd-vis pd-ch', name: () => t('Everyone and profitable traders: liquidation and stop levels at each price, on one dollar scale'), draw: groupsPicture },
} as const;

/**
 * Draw the three pictures into the hosts given (each optional), each with its "Illustrative data" label under it: their frames at once, what
 * they show as soon as the made-up numbers are here (`whenData`). `destroy()` stops waiting and takes them out again.
 */
export function mountVisuals(hosts: VisualHosts): { destroy(): void } {
  const placed: Element[] = [], pending: { svg: SVGSVGElement; draw: (s: SVGSVGElement, d: DemoData) => void }[] = [];
  for (const key of ['history', 'layers', 'groups'] as const) {
    const host = hosts[key];
    if (!host) continue;
    const p = PICTURES[key];
    const svg = sv('svg', { viewBox: `0 0 400 ${p.h}`, class: p.cls, role: 'img', 'aria-label': p.name(), 'aria-busy': 'true' });
    const box = document.createElement('div');
    box.className = 'pd-visual';
    const label = document.createElement('p');
    label.className = 'pd-vis-tag';
    label.textContent = t('Illustrative data');
    box.append(svg, label);
    host.append(box);
    placed.push(box);
    pending.push({ svg, draw: p.draw });
  }
  let gone = false;
  const stop = pending.length ? whenData(d => { if (gone) return; for (const { svg, draw } of pending) { draw(svg, d); svg.removeAttribute('aria-busy'); } }) : () => {};
  return { destroy() { gone = true; stop(); for (const box of placed.splice(0)) box.remove(); } };
}
