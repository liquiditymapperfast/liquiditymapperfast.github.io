/** Finite public UI protocol, separate from exchange metadata or book authority. */
export const ORDERBOOK_VENUE_MAX_SELECTED = 32;
export const ORDERBOOK_VENUE_MAX_CATALOG = 20;
export interface OrderbookVenueOption {
  id: string; name: string; supported: boolean; default: boolean; reason?: string; status?: string;
}
export interface OrderbookVenueCatalog {
  ok: true; maxSelected: number; selectedVenues: string[]; venues: OrderbookVenueOption[];
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid orderbook venue response');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new TypeError('Invalid bounded venue text');
  return value;
}
export function readOrderbookVenueCatalog(value: unknown): OrderbookVenueCatalog {
  const raw = record(value);
  if (raw.ok !== true) throw new Error(typeof raw.error === 'string' ? raw.error.slice(0, 180) : 'Orderbook venues are unavailable');
  if (raw.maxSelected !== ORDERBOOK_VENUE_MAX_SELECTED || !Array.isArray(raw.venues)
      || raw.venues.length < 1 || raw.venues.length > ORDERBOOK_VENUE_MAX_CATALOG) throw new TypeError('Invalid venue limits');
  const ids = new Set<string>();
  const venues = raw.venues.map(value => {
    const item = record(value), id = text(item.id, 32);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || ids.has(id) || typeof item.supported !== 'boolean' || typeof item.default !== 'boolean')
      throw new TypeError('Invalid or duplicate venue');
    ids.add(id);
    return { id, name: text(item.name, 80), supported: item.supported, default: item.default,
      ...(item.reason === undefined ? {} : { reason: text(item.reason, 160) }),
      ...(item.status === undefined ? {} : { status: text(item.status, 40) }) };
  });
  if (!Array.isArray(raw.selectedVenues) || raw.selectedVenues.length > ORDERBOOK_VENUE_MAX_SELECTED)
    throw new TypeError(`Select up to ${ORDERBOOK_VENUE_MAX_SELECTED} venues`);
  const selectedVenues: string[] = [];
  for (const value of raw.selectedVenues) {
    const id = text(value, 32);
    if (selectedVenues.includes(id) || !venues.some(v => v.id === id && v.supported)) throw new TypeError('Invalid selected venue');
    selectedVenues.push(id);
  }
  return { ok: true, maxSelected: ORDERBOOK_VENUE_MAX_SELECTED, selectedVenues, venues };
}
export function validateOrderbookVenueChoice(catalog: OrderbookVenueCatalog, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ORDERBOOK_VENUE_MAX_SELECTED) throw new RangeError(`Select up to ${ORDERBOOK_VENUE_MAX_SELECTED} venues`);
  const selected: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || selected.includes(id) || !catalog.venues.some(v => v.id === id && v.supported)) throw new TypeError('Invalid selected venue');
    selected.push(id);
  }
  return selected;
}
