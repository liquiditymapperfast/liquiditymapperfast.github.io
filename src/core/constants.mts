
// A five-token heatmap call at 12h cadence uses at most half of the default
// 20-token daily budget; the remaining half is reserved for manual/retry work.
export const DEFAULT_REFRESH_MS = 12 * 60 * 60 * 1000;
// Binance publishes no open-interest WebSocket, so its REST endpoint is polled. One call weighs 1 of the 2 400-weight-per-minute IP budget:
// every 2 s is 30 weight a minute (1.25 %), far inside the limit, and Binance's own value changes far more often than that. Override with
// OI_POLL_MS.
export const DEFAULT_BINANCE_OI_POLL_MS = 2_000;
export const DAILY_PROVIDER_TOKEN_BUDGET = 20;
