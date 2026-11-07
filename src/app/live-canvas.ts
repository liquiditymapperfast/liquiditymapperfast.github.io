/**
 * The WebGL canvases that do not keep their picture once the screen has shown it (`preserveDrawingBuffer` false): the glass with its waves,
 * the trade dust and the tape's trail. Copied from a later task they come out empty, so the screenshot asks each one to draw now and copies
 * it in the same task, and the GIF recorder watches their draws. Each registers itself with what draws it at once; a new one named here
 * shows in both.
 */
const live = new Map<HTMLCanvasElement, () => void>();

/** Name a canvas that loses its picture after the screen shows it, with what draws it now (nothing when there is nothing to draw). */
export function liveCanvas(canvas: HTMLCanvasElement, drawNow: () => void): void { live.set(canvas, drawNow); }

/** Whether a canvas is one of them. */
export const isLiveCanvas = (canvas: HTMLCanvasElement): boolean => live.has(canvas);

/** Have every one on the page draw now, so a copy made before this task ends holds its picture. One that cannot draw is left as it is. */
export function drawLiveCanvases(): void {
  for (const [canvas, drawNow] of live) {
    if (!canvas.isConnected) continue;
    try { drawNow(); } catch { /* left empty, as it was */ }
  }
}
