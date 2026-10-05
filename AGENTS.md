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
| `src/shared/` | Code shared by server and browser (grid step). |
| `src/app/` | Browser client (no framework): store, hub (data loading), raster worker, WebGL2 heatmap, panes, `ui.ts` (the shared settings panel and its row builders), `menu.ts` (previewing menu), `anomaly.ts` (the one rule for what stands out), `scope.ts` (spot / perp filter), `sound/` (rules, engine, orchestrator, panel). |
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

## Running and verifying

- `npm run dev` builds and starts the live server on `http://127.0.0.1:8787`; `npm run dev:fixture` runs offline. Before starting or restarting a local service, inspect existing process and port ownership; test on a spare `PORT` rather than stopping someone else's server.
- `npm test` builds and runs the Node suite; `npm run typecheck` runs the three strict projects; `npm run build` does both plus the Vite bundle.
- Visual inspection: compare against `example_images/` (a local folder that is not in git: reference screenshots for the heatmap, order book and footprint, plus `bookmap.PNG`, the Bookmap reference for the colour ramp and the Liquidity Tracker row). Heatmap, profile, ladder and footprint spacing, intensity and grouping follow those screenshots.
- All implementation and evidence artifacts belong in this repository. `Aggr_Trade` is a read-only reference.
- Do not edit source, configuration or served output during an acceptance measurement run.
