import { CVD_SPAN_MS, type CvdSpan } from './settings.ts';

/** The shortest window the column draws. */
export const MIN_WINDOW_MS = 60_000;
/** Recording that began less than this share of the window after its start is not worth a note. */
const NOTE_SHARE = 0.02;

export interface FlowWindow {
  /** The time the column draws, in ms. */
  t0: number; t1: number;
  /** When the flow began, when that is later than the start asked for (the window is trimmed to it, or has an empty left part); null otherwise. */
  since: number | null;
}

/**
 * The time the flow column draws. The Map span is the map's window up to now (the map runs a little past it, and nothing has happened there)
 * and starts where the flow does when it began later, so a map zoomed out over days does not squeeze a few minutes of flow into one
 * column; a span chosen by hand keeps its length and says when recording began. `earliest` is the first moment any counted instrument
 * has flow for (`Infinity` when none has yet).
 */
export function flowWindow(o: { span: CvdSpan; mapT0: number; mapT1: number; now: number; earliest: number }): FlowWindow {
  if (o.span !== 'map') {
    const t1 = o.now, t0 = t1 - CVD_SPAN_MS[o.span];
    return { t0, t1, since: o.earliest > t0 + (t1 - t0) * NOTE_SHARE && o.earliest < t1 ? o.earliest : null };
  }
  const t1 = Math.min(o.mapT1, o.now), asked = Math.min(o.mapT0, t1 - MIN_WINDOW_MS);
  if (!(o.earliest > asked) || o.earliest >= t1) return { t0: asked, t1, since: null };
  // Never shorter than the least the column can draw, whatever the flow's age.
  const t0 = Math.max(asked, Math.min(Math.floor(o.earliest / 1000) * 1000, t1 - MIN_WINDOW_MS));
  return { t0, t1, since: t0 - asked > (t1 - asked) * NOTE_SHARE ? o.earliest : null };
}
