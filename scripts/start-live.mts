// Normal local development entrypoint: use public exchange feeds and keep
// paid HyperTracker access disabled unless the caller opts in separately.
process.env.ENABLE_LIVE_FEEDS = 'true';
process.env.CANDLE_INTERVAL ??= '1m';
// Keep provider-backed UI available without an account or paid requests.
process.env.HYPERTRACKER_MODE ??= 'mock';
await import('../src/server/main.mjs');
