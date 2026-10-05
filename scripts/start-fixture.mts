// Deterministic offline entrypoint used for demos and browser acceptance.
process.env.ENABLE_LIVE_FEEDS = 'false';
process.env.ENABLE_HYPERTRACKER = 'false';
process.env.FIXTURE_TICK_MS ??= '1500';
// Fixture mode is a local visual/demo surface.  Keep its fast-changing book
// state in RAM unless the caller explicitly asks for a durable history file.
// This avoids making a stale or unavailable workstation database a startup
// dependency, while preserving the measured retention path for explicit runs.
process.env.HISTORY_DB ??= ':memory:';
// Keep provider-backed UI available without an account or paid requests.
process.env.HYPERTRACKER_MODE ??= 'mock';
await import('../src/server/main.mjs');
