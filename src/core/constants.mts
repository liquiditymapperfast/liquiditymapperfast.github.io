
// A five-token heatmap call at 12h cadence uses at most half of the default
// 20-token daily budget; the remaining half is reserved for manual/retry work.
export const DEFAULT_REFRESH_MS = 12 * 60 * 60 * 1000;
// Public OI polling is intentionally conservative for local development.
// Override with OI_POLL_MS when a faster research loop is needed.
export const DEFAULT_BINANCE_OI_POLL_MS = 60_000;
export const DAILY_PROVIDER_TOKEN_BUDGET = 20;
