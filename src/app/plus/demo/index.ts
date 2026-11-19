/**
 * The Plus demo, as the app and the Plus page take it: its styles and its two entry points.
 *
 *   mountDemo(host, { control? }) => { destroy(), pause() }   the interactive demo (demo.ts)
 *   mountVisuals({ history?, layers?, groups? }) => { destroy() }   the three feature pictures (visuals.ts)
 *
 * `control(host, store)` is a levels control to use instead of the demo's built-in one: it is given the card to build into and the demo's
 * own store (`DemoStore`, store.ts: `get`, `set` with one kind always on, `subscribe`), and returns `{ destroy() }`. Everything here is
 * made-up data labelled "Illustrative data"; nothing is fetched, and the app's settings are never read or written.
 *
 * Import this file, not the modules beside it, so the styles come along (the tests import the modules, which carry no styles).
 */
import './demo.css';

export { mountDemo, type DemoControl, type DemoHandle, type DemoOptions } from './demo.ts';
export { mountVisuals, type VisualHosts } from './visuals.ts';
export { createDemoStore, DEMO_KINDS, DEMO_START, kindsOn, lastOn, type DemoKind, type DemoLevels, type DemoStore, type DemoTraders } from './store.ts';
