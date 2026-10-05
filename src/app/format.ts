const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const usd = (value: number): string => !Number.isFinite(value) ? '–' : value === 0 ? '0' : Math.abs(value) < 1000 ? value.toFixed(0) : compact.format(value);

/** One formatter per number of decimals: `toLocaleString` builds a new Intl object on every call, which is slow enough to show when a frame prints hundreds of prices. */
const fixed: Intl.NumberFormat[] = [];
const fixedFormat = (decimals: number): Intl.NumberFormat => fixed[decimals] ??= new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

export function price(value: number, step = 0): string {
  if (!Number.isFinite(value)) return '–';
  const decimals = step > 0 ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))) : value >= 1000 ? 1 : value >= 1 ? 2 : 5;
  return fixedFormat(decimals).format(value);
}
const two = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export function clock(t: number, withDate = false): string {
  const d = new Date(t);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return withDate ? `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}` : time;
}
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
