import { askedSpan } from '../hub.ts';
import type { AppState } from '../store.ts';
import type { InfoLine } from '../infobox.ts';
import type { FlowLoader } from '../delta/flows.ts';
import { flowIds, mapVenues, oiFlowIds } from '../cvd/ids.ts';
import { tradedNet, tradedNetLine } from '../traded.ts';
import { measureDef, timeWords, type ProfileMetric } from './registry.ts';
import { placedOn } from '../traded/profiles.ts';
import type { PlacedBand } from '../traded/arrange.ts';
import { clock, startOfDay } from '../format.ts';
import { t } from '../i18n.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { bandCaption, bucketAt, timeLevels, timeLines, type TimeLevels } from './model.ts';
import { paintBand, type BandFrame } from './paint.ts';
import type { AbsorptionContext, BandHub, TimeWorker, Worked } from './measure.ts';

export type { AbsorptionContext, BandHub } from './measure.ts';

/** What the map hands the bands each frame: what the painter needs, the legend they were placed under, and what they add up over. */
export interface TopPlace extends BandFrame {
  /** The bottom of the legend plate (CSS px from the top of the map) the bands were placed under this frame. */
  legendBottom: number;
  /** The stretch the columns add up (heat-pane.ts `#tradedWindow`): what is on the chart, its whole minutes up to the one that is open. */
  window: { from: number; to: number };
  /** The absorption marks' thresholds, read only while a band shows a measure judged at them. */
  absorption: () => AbsorptionContext;
  /** Something a band asked for has come: draw again. */
  loaded: () => void;
}

/** Whether a band along the top shows: the bands are part of the Volume profile, so their places count only while the Volume profile is on. */
export const topShown = (state: Pick<AppState, 'show' | 'traded'>): boolean => state.show.traded && placedOn(state.traded.placements, 'top').length > 0;
/**
 * Whether a band drawn this frame shows a measure judged at the absorption marks: the marks' groups must then be loaded for the window, marks
 * on or off. Only the bands that fit count: one switched on with no room asks for nothing.
 */
export const topMarks = (state: Pick<AppState, 'show'>, drawn: readonly PlacedBand[]): boolean => state.show.traded && drawn.some(b => measureDef(b.instance.metric).judgedByMarks);

const MINUTE = 60_000;

/**
 * One measure along the top of the map: the column's measure added up by time over the stretch the columns add up, on the same markets, at
 * the same thresholds (measures/model.ts, the measure's worker in measures/defs/), drawn in the band it is given (measures/paint.ts). Kept
 * per measure, never per band, so a band that moves up or down the stack reads what was worked out already. Nothing is worked out or asked
 * for while it does not show. A frame that only moves the pointer reuses what was worked out: it is kept until the buckets, the window's
 * whole seconds or what it is read from change.
 */
export class TopProfile {
  readonly metric: ProfileMetric;
  readonly #worker: TimeWorker;
  #worked: Worked | null = null;
  #ids: { key: readonly unknown[]; ids: string[] } | null = null;
  /** The band, the rows and the levels drawn last (for the pointer). */
  #drawn: { band: { top: number; height: number }; headW: number; worked: Worked; levels: TimeLevels | null } | null = null;

  constructor(metric: ProfileMetric) { this.metric = metric; this.#worker = measureDef(metric).byTime.worker(); }

  /** Draw the measure in `band` for this frame. */
  paint(ctx: CanvasRenderingContext2D, state: AppState, hub: BandHub, f: TopPlace, band: { top: number; height: number }): void {
    this.#drawn = null;
    if (!(f.view.t1 > f.view.t0)) return;
    const now = pageNow(), worked = this.work(state, hub, f.window, f.view.t1 - f.view.t0, f.pw, now, f.absorption, f.loaded);
    if (!worked) return;
    const rows = worked.rows, s = state.traded, levels = s.valueArea ? timeLevels(rows, s.share / 100) : null;
    // The pointer over the band frames its bucket, as a row of the column is framed.
    const hv = state.hover, y = hv && hv.source === 'heat' && hv.price !== null ? f.view.yOf(hv.price, f.ph) : NaN;
    const hovered = hv && y >= band.top && y <= band.top + band.height ? bucketAt(rows, hv.t) : -1;
    const headW = paintBand(ctx, rows, band, f, { bars: s.bars, emphasis: s.emphasis, levels, ...this.#header(worked), caption: bandCaption(rows.step, worked.limit, this.metric, worked.spacingMs), hovered, now });
    this.#drawn = { band, headW, worked, levels };
  }

  /** Not shown this frame: nothing to point at, and what was worked out is let go. */
  hide(): void { this.#drawn = null; this.#worked = null; }

  /** The column's header for these rows: the measure's own (measures/defs/), with what its record leaves out. */
  #header(w: Worked): { head: string; sub: string; warn: boolean; net: { text: string; sign: number } | null } {
    const rows = w.rows, net = rows.total > 0 ? { text: tradedNetLine(rows), sign: Math.sign(tradedNet(rows)) } : null;
    const { head, sub, warn } = measureDef(this.metric).header(rows, w.flags);
    if (w.unavailable && !(rows.total > 0)) return { head, sub: t('not on this server'), warn: false, net: null };
    // A chart wider than a source answers: its newest part, said as the column says it.
    if (w.since !== null) return { head, sub: t('since {time}', { time: clock(w.since, w.since < startOfDay(Date.now())) }), warn: true, net };
    return { head, sub, warn, net };
  }

  /** Whether a point of the map is on the band's header, which opens the profiles' settings (the Volume profile panel, at the places). */
  onHeader(x: number, y: number): boolean { const d = this.#drawn; return !!d && x >= 0 && x <= d.headW && y >= d.band.top && y <= d.band.top + d.band.height; }

  /** The box for the bucket under the pointer when it is over the band, off its header (`x`, `y` on the map, `t` its time), and where it opens; null elsewhere. */
  readout(x: number, y: number, time: number): { lines: InfoLine[]; y: number } | null {
    const d = this.#drawn;
    if (!d || y < d.band.top || y > d.band.top + d.band.height) return null;
    // The header is a button (it opens the settings): nothing is read out over it, not even the map under it.
    if (x <= d.headW) return { lines: [], y: d.band.top + d.band.height };
    const i = bucketAt(d.worked.rows, time);
    if (i < 0) return null;
    return { lines: timeLines(d.worked.rows, i, { metric: this.metric, words: timeWords(this.metric), spacingMs: d.worked.spacingMs, levels: d.levels, now: pageNow() }), y: d.band.top + d.band.height };
  }

  /**
   * The measure by time over the columns' window (up to now, its newest eight days at most, as a source answers the columns) in buckets
   * about as thick as the column's rows at this zoom: kept while nothing it depends on changed, the bucket under way worked out again at
   * most once a second. The markets are the columns' (`flowIds`), each measure narrowed as its column narrows them.
   */
  work(state: AppState, hub: BandHub, win: { from: number; to: number }, span: number, pw: number, now: number, absorption: () => AbsorptionContext, loaded: () => void = () => {}): Worked | null {
    const { from, to } = askedSpan(win.from, Math.min(win.to, now));
    if (!(to > from) || !(span > 0)) return null;
    const since = from > win.from + MINUTE ? from : null, ids = this.#flowIds(state, hub), live = state.followLive && !replaying();
    return this.#worked = this.#worker.work({ state, hub, win, from, to, whole: askedSpan(win.from, win.to), since, span, pw, now, second: Math.floor(to / 1000), ids, live, absorption, loaded }, this.#worked);
  }

  /**
   * The columns' markets (`flowIds`; open interest's whatever the Spot / Perp filter says, `oiFlowIds`), worked out again only when what
   * they depend on changes (as the footprint's markets are).
   */
  #flowIds(state: AppState, hub: FlowLoader): string[] {
    const onMap = mapVenues(state), key = [state.markets, state.disabledVenues, state.scope, onMap ? [...onMap].sort().join(',') : null, hub.flow.ids.length, hub.flow.loads];
    if (!this.#ids || this.#ids.key.some((k, i) => k !== key[i])) this.#ids = { key, ids: (this.metric === 'oi' ? oiFlowIds : flowIds)(state, hub.flow.ids) };
    return this.#ids.ids;
  }
}

/**
 * The bands along the top of the map (Karl, 2026-10-20: any measure, stacked): each placed band draws its measure, one `TopProfile` a
 * measure, under the legend and the map's corner buttons. A measure no band shows works nothing out and asks for nothing.
 */
export class TopBands {
  readonly #profiles = new Map<ProfileMetric, TopProfile>();
  #drawn: TopProfile[] = [];
  #placedFor: number | null = null;

  /** The measure's worker by time: made the first time a band shows it, and kept (what it loaded is the measure's, wherever its band goes). */
  profile(metric: ProfileMetric): TopProfile {
    let p = this.#profiles.get(metric);
    if (!p) { p = new TopProfile(metric); this.#profiles.set(metric, p); }
    return p;
  }

  /** Draw the bands placed this frame (traded/arrange.ts), or nothing while the Volume profile is off. */
  paint(ctx: CanvasRenderingContext2D, state: AppState, hub: BandHub, f: TopPlace, bands: readonly PlacedBand[]): void {
    const shown = state.show.traded ? bands : [];
    this.#placedFor = topShown(state) ? f.legendBottom : null;
    const drawn = new Set<ProfileMetric>();
    this.#drawn = [];
    for (const b of shown) { const p = this.profile(b.instance.metric); p.paint(ctx, state, hub, f, b); drawn.add(p.metric); this.#drawn.push(p); }
    for (const [metric, p] of this.#profiles) if (!drawn.has(metric)) p.hide();
  }

  /**
   * Whether the bands were placed under another legend than the one this frame drew: the legend is drawn last, over everything, so the
   * bands are placed under the last frame's, and a legend that grew or shrank asks for one more frame.
   */
  misplaced(legendBottom: number): boolean { return this.#placedFor !== null && this.#placedFor !== legendBottom; }

  /** Whether a point of the map is on a band's header (each band's header opens the settings). */
  onHeader(x: number, y: number): boolean { return this.#drawn.some(p => p.onHeader(x, y)); }

  /** The box for the bucket under the pointer, from the band it is over; null off the bands. */
  readout(x: number, y: number, time: number): { lines: InfoLine[]; y: number } | null {
    for (const p of this.#drawn) { const r = p.readout(x, y, time); if (r) return r; }
    return null;
  }
}
