/**
 * Touch gestures, recognised from raw pointer positions. Pure (no DOM, no clock of its own) so a test can feed it a finger's path;
 * `bindTouch` is the thin adapter that feeds it from a canvas's pointer events.
 *
 * One finger:  tap | double tap | press-and-hold, then drag ("scrub") | drag ("pan", with the lift-off velocity for a fling)
 * Two fingers: pinch, reported as the separation of the fingers on each axis separately, so the host can zoom time and price on
 *              their own scales and keep the data under each finger under that finger.
 *
 * A finger that stays within `slop` px of where it landed is a tap if lifted, or a hold if kept down for `holdMs`. Once a second finger
 * lands, the first finger's gesture ends and the pinch begins; when one finger lifts the other is ignored until it lifts too, because
 * letting it carry on as a pan would make the picture jump by the distance the pinch had moved.
 */
export interface Pt { x: number; y: number }

export interface PinchInfo {
  /** Midpoint of the two fingers now, and when the pinch began. */
  mid: Pt; startMid: Pt;
  /** Separation of the fingers (absolute, per axis, and straight-line), when the pinch began and now. */
  start: { dx: number; dy: number; dist: number };
  now: { dx: number; dy: number; dist: number };
}

export interface GestureHandlers {
  /** A first finger landed. */
  down?(p: Pt): void;
  tap?(p: Pt): void;
  doubleTap?(p: Pt): void;
  /** The finger has stayed put long enough: the host should show whatever a hold shows. Without this handler, nothing is timed. */
  hold?(p: Pt): void;
  holdMove?(p: Pt): void;
  holdEnd?(p: Pt): void;
  panStart?(p: Pt): void;
  /** The finger moved by `delta` (px) to `p`; `velocity` is px/ms over the last moments. */
  pan?(delta: Pt, p: Pt, velocity: Pt): void;
  /** The finger lifted at `velocity` px/ms, or `null` when the pan was cut short (a second finger landed, or the gesture was cancelled). */
  panEnd?(velocity: Pt | null): void;
  pinchStart?(info: PinchInfo): void;
  pinch?(info: PinchInfo): void;
  pinchEnd?(): void;
  /** Whatever was in progress was interrupted (the browser took the touch, a dialog opened). */
  cancel?(): void;
}

export interface GestureOptions {
  /** How far a finger may wander and still be a tap or a hold (px). */
  slop?: number;
  /** How long a still finger takes to become a hold (ms). */
  holdMs?: number;
  /** Two taps this close in time (ms) and place (px) are a double tap. */
  doubleTapMs?: number;
  doubleTapDistance?: number;
  /** A lift this soon after the fingers' last moves still has a velocity (ms). */
  velocityWindowMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

type Mode = 'idle' | 'pending' | 'panning' | 'holding' | 'pinching' | 'ignoring';
interface Finger { p: Pt; start: Pt }

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

export class GestureRecognizer {
  #fingers = new Map<number, Finger>();
  #mode: Mode = 'idle';
  #timer: unknown = null;
  #lastTap: { p: Pt; t: number } | null = null;
  #trail: { p: Pt; t: number }[] = [];
  #last: Pt = { x: 0, y: 0 };
  #pinchStart: PinchInfo['start'] & { mid: Pt } | null = null;
  readonly #o: Required<GestureOptions>;

  constructor(private h: GestureHandlers, options: GestureOptions = {}) {
    this.#o = {
      slop: 10, holdMs: 420, doubleTapMs: 300, doubleTapDistance: 32, velocityWindowMs: 90,
      setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: id => clearTimeout(id as ReturnType<typeof setTimeout>), ...options,
    };
  }

  /** True while any finger is down. */
  get active(): boolean { return this.#fingers.size > 0; }
  get mode(): Mode { return this.#mode; }

  pointerDown(id: number, p: Pt, t: number): void {
    if (this.#fingers.has(id)) return;
    if (this.#fingers.size === 0) {
      this.#fingers.set(id, { p, start: p });
      this.#mode = 'pending'; this.#last = p; this.#trail = [{ p, t }];
      this.h.down?.(p);
      if (this.h.hold) this.#timer = this.#o.setTimer(() => this.#holdFired(), this.#o.holdMs);
      return;
    }
    if (this.#fingers.size === 1 && this.#mode !== 'ignoring') {
      this.#clearTimer();
      if (this.#mode === 'panning') this.h.panEnd?.(null);
      else if (this.#mode === 'holding') this.h.holdEnd?.(this.#last);
      this.#lastTap = null;
      this.#fingers.set(id, { p, start: p });
      this.#mode = 'pinching';
      const info = this.#pinchInfo(true);
      this.h.pinchStart?.(info);
      return;
    }
    // A third finger, or any finger while one is being ignored: not part of a gesture.
    this.#fingers.set(id, { p, start: p });
  }

  pointerMove(id: number, p: Pt, t: number): void {
    const finger = this.#fingers.get(id); if (!finger) return;
    finger.p = p;
    switch (this.#mode) {
      case 'pending':
        if (dist(p, finger.start) <= this.#o.slop) return;
        this.#clearTimer(); this.#mode = 'panning';
        this.h.panStart?.(finger.start);
        this.#pan(p, t, finger.start);
        return;
      case 'panning': this.#pan(p, t, this.#last); return;
      case 'holding': this.#last = p; this.h.holdMove?.(p); return;
      case 'pinching': this.h.pinch?.(this.#pinchInfo(false)); return;
      default: return;
    }
  }

  pointerUp(id: number, p: Pt, t: number): void {
    const finger = this.#fingers.get(id); if (!finger) return;
    finger.p = p;
    this.#fingers.delete(id);
    switch (this.#mode) {
      case 'pending': {
        this.#clearTimer(); this.#mode = 'idle';
        const last = this.#lastTap;
        if (last && t - last.t <= this.#o.doubleTapMs && dist(last.p, p) <= this.#o.doubleTapDistance) { this.#lastTap = null; this.h.doubleTap?.(p); }
        else { this.#lastTap = { p, t }; this.h.tap?.(p); }
        return;
      }
      case 'panning': this.#mode = 'idle'; this.h.panEnd?.(this.#velocity(t)); return;
      case 'holding': this.#mode = 'idle'; this.h.holdEnd?.(p); return;
      case 'pinching':
        this.h.pinchEnd?.();
        this.#mode = this.#fingers.size > 0 ? 'ignoring' : 'idle';
        return;
      case 'ignoring': if (this.#fingers.size === 0) this.#mode = 'idle'; return;
      default: if (this.#fingers.size === 0) this.#mode = 'idle';
    }
  }

  pointerCancel(id: number): void {
    if (!this.#fingers.has(id)) return;
    this.cancel();
  }

  /** End whatever is in progress without a result (and forget every finger). */
  cancel(): void {
    const was = this.#mode;
    this.#clearTimer(); this.#fingers.clear(); this.#mode = 'idle'; this.#lastTap = null;
    if (was !== 'idle' && was !== 'ignoring') { if (was === 'panning') this.h.panEnd?.(null); this.h.cancel?.(); }
  }

  #holdFired(): void {
    this.#timer = null;
    if (this.#mode !== 'pending') return;
    this.#mode = 'holding';
    const finger = [...this.#fingers.values()][0];
    this.#last = finger?.p ?? this.#last;
    this.h.hold?.(this.#last);
  }
  #clearTimer(): void { if (this.#timer !== null) { this.#o.clearTimer(this.#timer); this.#timer = null; } }

  #pan(p: Pt, t: number, from: Pt): void {
    const delta = { x: p.x - from.x, y: p.y - from.y };
    this.#last = p;
    this.#trail.push({ p, t });
    const cutoff = t - this.#o.velocityWindowMs * 2;
    while (this.#trail.length > 2 && this.#trail[0]!.t < cutoff) this.#trail.shift();
    this.h.pan?.(delta, p, this.#velocity(t));
  }

  /** Velocity (px/ms) over the last `velocityWindowMs`; zero when the finger rested before lifting. */
  #velocity(t: number): Pt {
    const window = this.#o.velocityWindowMs, trail = this.#trail;
    const end = trail[trail.length - 1];
    if (!end || t - end.t > window) return { x: 0, y: 0 };
    let from = end;
    for (let i = trail.length - 2; i >= 0; i--) { if (end.t - trail[i]!.t > window) break; from = trail[i]!; }
    const dt = end.t - from.t;
    return dt > 0 ? { x: (end.p.x - from.p.x) / dt, y: (end.p.y - from.p.y) / dt } : { x: 0, y: 0 };
  }

  #pinchInfo(first: boolean): PinchInfo {
    const [a, b] = [...this.#fingers.values()] as [Finger, Finger];
    const now = { dx: Math.abs(a.p.x - b.p.x), dy: Math.abs(a.p.y - b.p.y), dist: dist(a.p, b.p) };
    const mid = { x: (a.p.x + b.p.x) / 2, y: (a.p.y + b.p.y) / 2 };
    if (first) this.#pinchStart = { ...now, mid };
    const s = this.#pinchStart!;
    return { mid, startMid: s.mid, start: { dx: s.dx, dy: s.dy, dist: s.dist }, now };
  }
}

/**
 * How much to scale one axis for a pinch: the ratio of the finger separation on that axis, applied fully when the fingers began far
 * apart on it, fading to nothing when they began aligned with the other axis (a separation of a few pixels says nothing about scale).
 * `from` and `to` are the separation at the start and now; the result is the factor to zoom in by (above 1) or out (below 1).
 */
export function axisPinchScale(from: number, to: number, floor = 24, ramp = 24): number {
  if (!(from > 0) || !(to >= 0)) return 1;
  const weight = Math.max(0, Math.min(1, (from - floor) / ramp));
  if (weight === 0) return 1;
  // Never let one finger pair collapse the axis to nothing or blow it up past reason in a single gesture.
  const ratio = Math.max(0.08, Math.min(12, to / from));
  return Math.pow(ratio, weight);
}

/** Position of a pointer event inside `el`. */
const local = (el: HTMLElement, e: PointerEvent): Pt => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

/**
 * Feed `recognizer` from the touch pointers on `el` (mouse and pen are left to the host's own handlers). The element is made
 * `touch-action: none` here as well as in the stylesheet, so the browser never starts a scroll or a page zoom of its own on it.
 */
export function bindTouch(el: HTMLElement, recognizer: GestureRecognizer): () => void {
  el.style.touchAction = 'none';
  const own = (e: PointerEvent): boolean => e.pointerType === 'touch';
  const down = (e: PointerEvent): void => { if (!own(e)) return; try { el.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ } recognizer.pointerDown(e.pointerId, local(el, e), e.timeStamp); };
  const move = (e: PointerEvent): void => { if (own(e)) recognizer.pointerMove(e.pointerId, local(el, e), e.timeStamp); };
  const up = (e: PointerEvent): void => { if (own(e)) { recognizer.pointerUp(e.pointerId, local(el, e), e.timeStamp); if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } };
  const cancel = (e: PointerEvent): void => { if (own(e)) recognizer.pointerCancel(e.pointerId); };
  const menu = (e: Event): void => e.preventDefault();
  el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', cancel);
  // A long press opens the browser's context menu on some phones; a hold means something here instead.
  el.addEventListener('contextmenu', menu);
  return () => {
    el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('contextmenu', menu); recognizer.cancel();
  };
}
