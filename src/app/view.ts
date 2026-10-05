/** Time/price viewport shared by every pane that draws against the main chart. */
export interface Bounds { t0: number; t1: number; p0: number; p1: number }

export class View implements Bounds {
  t0: number; t1: number; p0: number; p1: number;
  constructor(b: Bounds) { this.t0 = b.t0; this.t1 = b.t1; this.p0 = b.p0; this.p1 = b.p1; }
  set(b: Bounds): void { this.t0 = b.t0; this.t1 = b.t1; this.p0 = b.p0; this.p1 = b.p1; }
  clone(): Bounds { return { t0: this.t0, t1: this.t1, p0: this.p0, p1: this.p1 }; }
  xOf(t: number, width: number): number { return (t - this.t0) / (this.t1 - this.t0) * width; }
  tOf(x: number, width: number): number { return this.t0 + x / width * (this.t1 - this.t0); }
  yOf(p: number, height: number): number { return (1 - (p - this.p0) / (this.p1 - this.p0)) * height; }
  pOf(y: number, height: number): number { return this.p0 + (1 - y / height) * (this.p1 - this.p0); }
  /** Pan by pixel deltas (dx right, dy down). */
  pan(dx: number, dy: number, width: number, height: number): void {
    const dt = -dx / width * (this.t1 - this.t0), dp = dy / height * (this.p1 - this.p0);
    this.t0 += dt; this.t1 += dt; this.p0 += dp; this.p1 += dp;
  }
  /** Zoom the price axis about the pixel row `y`; factor > 1 zooms out. */
  zoomPrice(factor: number, y: number, height: number): void {
    const anchor = this.pOf(y, height), f = (y / height);
    const span = (this.p1 - this.p0) * factor;
    this.p1 = anchor + f * span; this.p0 = this.p1 - span;
  }
  /** Zoom the time axis about the pixel column `x`; factor > 1 zooms out. */
  zoomTime(factor: number, x: number, width: number): void {
    const anchor = this.tOf(x, width), f = x / width;
    const span = (this.t1 - this.t0) * factor;
    this.t0 = anchor - f * span; this.t1 = this.t0 + span;
  }
}

/** 1-2-5 nice step so that roughly `target` ticks fit in `range`. */
export function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const exp = Math.floor(Math.log10(raw)), unit = raw / 10 ** exp;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * 10 ** exp;
}
