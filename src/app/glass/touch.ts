/**
 * The person's own hand on the glass (Karl, 2026-11-03: "push more interactions with the background animation, the waves animations ... as
 * long as it is free work on the GPU ... and keep its 60 FPS"): what a pointer moving over the glass, a key pressed in it and a splitter
 * dragged send into the wave field (glass/waves.ts), as plain sums so that they can be tested without a card.
 *
 * A hand at rest sends nothing, so a still page stays still and the field stops (it runs only while something is in it, a few seconds after
 * the last). Moving, it leaves a wake as a finger drawn through water does: a little height each substep along its way, more the faster it
 * goes, to a cap (a flick is not an order), as wide as a fingertip. Faster than the waves run in the glass (600 px a second) the rings it
 * leaves fold into a V behind it, the bow wave of a boat. A key pressed sends one ring from where it was pressed; a splitter dragged pushes
 * the water before it, a straight wave along its length, as high as it moved fast.
 */

/** How fast a hand must move to leave a wake (CSS px a millisecond): slower is a hand at rest, its tremor included. */
export const WAKE_MIN_SPEED = 0.05;
/** The wake's height a substep for each px/ms of speed, and its cap: an order's pulse is 0.35 to 1.6 at once, a wake a breath of that. */
export const WAKE_GAIN = 0.08, WAKE_MAX = 0.22;
/** How wide the wake is (CSS px): about a fingertip. */
export const WAKE_WIDTH = 5;
/** A key pressed in the glass: one ring, about a small order's. */
export const PRESS = { amp: 0.7, width: 8 } as const;
/** A splitter's push: its height for each px/ms it moved, the cap, and how wide its line is (CSS px). */
export const PUSH_GAIN = 0.9, PUSH_MAX = 0.7, PUSH_WIDTH = 4;
/** The frame time a speed is reckoned over (ms): a first frame after a still spell counts as a long one, never as nothing. */
export const FRAME_MIN_MS = 8, FRAME_MAX_MS = 50;
/** A pointer that sent nothing for this long (ms) starts a new wake where it is, rather than one drawn from where it last was. */
export const WAKE_BREAK_MS = 120;

const speedOf = (px: number, ms: number): number => (px > 0 && ms > 0 ? px / Math.min(FRAME_MAX_MS, Math.max(FRAME_MIN_MS, ms)) : 0);

/** The wake's height a substep for a hand that moved `px` in a frame of `ms` (0: it sends nothing). */
export function wakeAmp(px: number, ms: number): number {
  const speed = speedOf(px, ms);
  return speed < WAKE_MIN_SPEED ? 0 : Math.min(WAKE_MAX, WAKE_GAIN * speed);
}

/** The height of the line a splitter dragged `px` in a frame of `ms` pushes into the field (0: nothing). */
export function pushAmp(px: number, ms: number): number {
  const speed = speedOf(px, ms);
  return speed < WAKE_MIN_SPEED ? 0 : Math.min(PUSH_MAX, PUSH_GAIN * speed);
}
