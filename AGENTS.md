# LiquidityMapperFast agent instructions

## Language and checking

All authored application code, scripts and tests are strict TypeScript: `.ts`/`.tsx` (browser, shared) and `.mts` (Node ESM). Keep the three compiler projects strict (`tsconfig.json` browser+shared, `tsconfig.node.json` server, `tsconfig.tools.json` scripts and tests); do not enable `allowJs`/`checkJs`, add blanket `ts-nocheck` or broad `any` casts. Type annotations do not validate exchange frames, HTTP bodies or storage: validate at those boundaries at runtime.

Permanent non-TypeScript exceptions: generated build output (`dist/`, `build/`), the generated WASM glue in `src/app/wasm/`, and the Rust kernels below.

## Layout

| Path | Role |
| --- | --- |
| `src/adapters/` | Venue adapters: pure normalisation, depth sessions, connectors for ~20 venues. |
| `src/core/`, `src/analytics/`, `src/domain/` | Pure helpers and contracts used by the server. |
| `src/server/` | Local server: live feed manager, reducers (`http.mts`), history (SQLite), HyperTracker provider. |
| `src/server/v2/` | The data plane the UI uses: valued levels, depth recorder, footprint recorder, binary wire, `/api/v2/*` and `/api/v2/ws`. Installed in front of the legacy dispatcher by `installV2`. |
| `src/shared/` | Code shared by server and browser (grid step, the flow recorder and series in `flow.ts`). |
| `src/app/` | Browser client (no framework): store, hub (data loading), raster worker, WebGL2 heatmap, panes, `ui.ts` (the shared settings panel and its row builders), `menu.ts` (previewing menu), `anomaly.ts` (the one rule for what stands out), `scope.ts` (spot / perp filter), `sound/` (rules, engine, orchestrator, panel). |
| `src/app/cvd/` | The flow column's pure parts (families, ranking, row heights, hit tests, bursts, price track, words); `panes/cvd-pane.ts` is its canvas. |
| `src/app/sound/` | Sound settings, the trade tiers, the panel alerts (`alerts.ts`, detectors in `alert-rules.ts`). |
| `crates/hlm-kernels/` | Rust/WASM compute kernels. |
| `tests/`, `scripts/` | Node tests (`node --test`) and operational scripts. |

## Rust/WASM compute kernels (approved exception, 2026-10-04)

Compute-bound inner loops (heatmap rasterisation, level grouping) live in `crates/hlm-kernels`, compiled to WebAssembly with wasm-bindgen. Rules:

- Kernels are pure functions over flat typed arrays; JavaScript owns all state, validation and I/O. A kernel holds no state between calls, touches no DOM and parses no exchange frame.
- Every kernel has native `cargo test` unit tests (`npm run test:wasm`) and a Node contract test (`tests/app-client.test.mts`) that loads the committed wasm and checks it against the server's JS implementation of the same spreading.
- Build with `npm run build:wasm` (needs the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129). The generated glue and `.wasm` in `src/app/wasm/` are committed so a checkout builds without a Rust toolchain; regenerate whenever the crate changes.
- The crate keeps its default `crates/hlm-kernels/target/` (gitignored); create no other Cargo target directories.
- Do not add WASM for work that should not run at all. Memoise or delete first; profile before and after and record the numbers in `docs/deslop/`.

## Performance and memory

The earlier byte-accounting "admission/lease/grant/reservation" machinery was measured as the dominant CPU cost on both client and server and was removed (`docs/deslop/baseline-2026-10-04.md`). Do not reintroduce per-message or per-frame memory estimation, cross-tab byte leases or response-size reservations. Bound memory structurally: ring buffers, fixed retention windows (`RETENTION_MS` in the recorders), capped frames.

Measure with an isolated, visible-state headless Chrome over CDP. A tab reporting `visibilityState: hidden` has throttled timers and rAF; its numbers are meaningless. Use the real GPU path for WebGL timings (software GL says nothing about GPU frame time).

- A feed restart must never leave the server without feeds. `LiveFeedManager.start()` retires every old feed before its metadata requests, so an error in between used to leave a running manager with no feed and nothing to reopen one (12 hours of frozen candles and seven stopped venues, 2026-10-06; `docs/deslop/feed-recovery-2026-10-06.md`). `start()` now schedules a recovery with the last configuration that finished, a watchdog (`checkLiveness`) catches a start that hangs or a manager with specs and no feed, and `/api/diagnostics` reports `feedManager`. Keep new work between retire and open inside that guard, and keep recovery and watchdog timers `unref`ed.

## Phones and tablets

- Two attributes on `<html>` (`src/app/device.ts`, tested in `tests/app-device.test.mts`) drive the touch arrangement: `data-layout` (`phone`, `phone-landscape`, `desktop`: how the panes are arranged) and `data-bar` (`compact`, `full`: how the controls are). Put mobile CSS in `src/app/mobile.css` under one of them (or `(pointer: coarse)`), never in a user-agent test, and keep the desktop rules in `styles.css` unchanged. Script that must differ reads `isPhone()` / `compactBar()` / `isCoarse()` from the same module.
- A phone must not write the desktop's saved layout (`hlm-layout-v2`): `Layout.#persist` returns early when `isPhone()`. The dock's own sizes use `hlm-dock-size`.
- Touch gestures come from the pure recogniser in `src/app/touch.ts` (tested with a fake clock); panes bind it with `bindTouch` and leave mouse and pen to their existing handlers. A pinch is reported per axis (`axisPinchScale`).
- Test by emulation: Chrome over CDP with `Emulation.setDeviceMetricsOverride { mobile: true, deviceScaleFactor: 3 }`, `Emulation.setTouchEmulationEnabled`, `Input.dispatchTouchEvent`, and `Emulation.setCPUThrottlingRate` for a slow phone. Check portrait, landscape (844 x 390), a small phone (360 x 640) and a tablet (820 x 1180 and 1180 x 820). It is Chrome, not Safari; say so when reporting.
- Never let a floating panel, menu or dropdown rely on `position` computed from its anchor on a touch screen: they are bottom sheets there (`ui.ts`, `menu.ts`, `sheet.ts`).

## Words and look

- Every sentence a person reads goes through `t('...')` (or `tn(n, 'one', 'other')` for a count) from `src/app/i18n.ts`; English is the key and `{braces}` mark values. `tests/app-i18n-packs.test.mts` fails on a text left outside `t()` and on a pack missing it, so add the text to all ten packs in `src/app/i18n/` (`npm run i18n:template -- xx` shows what a pack needs). `boot.ts` loads the language before `main.ts`, so top-level `t()` is fine in the page's own modules, but code that runs in a worker must not rely on it. Status text that code parses (`stateOfStatus`) stays English. Details: `docs/languages.md`.
- The guide's text is data in `src/app/guide/content.ts` and the words its pictures draw go through `tg('...')` (`guide/words.ts`); both are translated in `src/app/guide/i18n/<code>.json`, fetched when the guide opens. A change to a guide text or a picture word needs the ten guide packs updated (`npm run i18n:guide -- xx` writes the template; `tests/app-guide-i18n.test.mts` checks coverage, markup and placeholders), and the guide must still read in ten to fifteen minutes (`tests/app-guide.test.mts`).
- The window language (shapes, edges, title bars, hard shadows) is `src/app/chrome.css`; its tones come from `chromeFor` in `theme.ts` (never hard-code an edge or face colour, and keep `BEVEL` the one dial). No `backdrop-filter`, blurred shadow or pill shape: they are the costly ones over canvases. Glyphs on buttons are drawn (CSS masks or bars), not typed.
- Canvas popups go through `infobox.ts` (`paintInfoBox`), page-element ones through `hovercard.ts` (for panes too short to hold a box); build their lines in plain functions so tests need no canvas.
- Do not write the DOM on every pointer move unless the value changed: assigning the text a node already has still invalidates style and layout. Header readouts use `setHtml` / `setText`, which write only on change. Measure with CDP `Performance.getMetrics` (see `docs/deslop/performance-2026-10-05.md`).

## Running and verifying

- `npm run dev` builds and starts the live server on `http://127.0.0.1:8787` (a page it serves uses it as its data source); `npm run dev:client` runs the page alone, reading the exchanges from the browser; `npm run build:site` builds the static site; `npm run dev:fixture` runs offline. Before starting or restarting a local service, inspect existing process and port ownership; test on a spare `PORT` rather than stopping someone else's server.
- `npm test` builds and runs the Node suite; `npm run typecheck` runs the three strict projects; `npm run build` does both plus the Vite bundle.
- Visual inspection: compare against `example_images/` (a local folder that is not in git: reference screenshots for the heatmap, order book and footprint, plus `bookmap.PNG`, the Bookmap reference for the colour ramp and the Liquidity Tracker row). Heatmap, profile, ladder and footprint spacing, intensity and grouping follow those screenshots.
- All implementation and evidence artifacts belong in this repository. `Aggr_Trade` is a read-only reference.
- Do not edit source, configuration or served output during an acceptance measurement run.
