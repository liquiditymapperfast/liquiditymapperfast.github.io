/**
 * Where Liquidation levels reads its file, and its setting (kept apart so the store and the toolbar can read them without loading the
 * feature's code).
 */

/**
 * What the levels show (one choice for the whole page: the map's stripe and column, the phone's Liq tab, the Depth pane's history): three
 * kinds, each a switch of its own (the liquidation levels, the stop orders, the take-profit orders), at least one of them on, and whose
 * liquidations (every position, or HyperTracker's profitable traders'). The curve adds up the liquidations and the stops that are on; take
 * profits are drawn beside it, or, on alone, as a curve of their own. Everything but liquidations of all traders is Plus.
 */
export type LiqPart = 'liq' | 'stops' | 'takes';
export type LiqGroup = 'all' | 'profitable';
export const LIQ_PARTS: readonly LiqPart[] = ['liq', 'stops', 'takes'];
export const LIQ_GROUPS: readonly LiqGroup[] = ['all', 'profitable'];

/**
 * The Chart deck's Liquidation levels: whether they are drawn on the map, whether their own column stands beside the profile column, and what
 * they show (`liq`, `stops`, `takes`: at least one on; `group`).
 */
export interface LiqLevelSettings { on: boolean; column: boolean; liq: boolean; stops: boolean; takes: boolean; group: LiqGroup }

/**
 * A saved setting, checked, whichever form it was saved in (settings, a layout or a layouts file, a backup, the old address's hand-over: all
 * go through here). What a save from before the feature lacks reads as on (new features start on). The three switches as saved, where at
 * least one is on; a save of one kind and a take-profit switch (before 2026-11-19) as that kind: `liq` liquidations, `stops` stops, `both`
 * the two, its take profits kept. Anything else, a save from before the Plus choices included, reads as the free view: liquidations of
 * everyone, no take profits. Any other group value reads as everyone's (`all`).
 */
export function readLiqLevels(saved: unknown): LiqLevelSettings {
  const s = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  const shown = { on: typeof s.on === 'boolean' ? s.on : true, column: typeof s.column === 'boolean' ? s.column : true };
  const group: LiqGroup = (LIQ_GROUPS as readonly unknown[]).includes(s.group) ? s.group as LiqGroup : 'all';
  const free: LiqLevelSettings = { ...shown, liq: true, stops: false, takes: false, group: 'all' };
  if ('liq' in s || 'stops' in s) {
    const liq = s.liq === true, stops = s.stops === true, takes = s.takes === true;
    return liq || stops || takes ? { ...shown, liq, stops, takes, group } : free;
  }
  const takes = s.takes === true;
  if (s.kind === 'liq') return { ...shown, liq: true, stops: false, takes, group };
  if (s.kind === 'stops') return { ...shown, liq: false, stops: true, takes, group };
  if (s.kind === 'both') return { ...shown, liq: true, stops: true, takes, group };
  return free;
}

/**
 * The levels service's public address: hlm-levels on hiverust behind a Cloudflare tunnel (2026-11-01). Empty would mean no service, and then the
 * Chart deck has no Liquidation levels button.
 */
export const LIQ_LEVELS_URL = 'https://levels.hiverust.dev/v1/btc/liquidations.json';

let read: { search: string; url: string } | null = null;

/**
 * The address in use: a local service may stand in while testing (`?levels=http://127.0.0.1:8790/v1/btc/liquidations.json`). Read again only
 * when the page's address changes: the map's layout asks for it with every frame.
 */
export function liqLevelsUrl(search: string = typeof location === 'undefined' ? '' : location.search): string {
  if (read?.search !== search) read = { search, url: urlFrom(search) };
  return read.url;
}

/**
 * The Plus files beside the levels file (`…/v1/btc/liquidations.json` → `…/v1/plus/btc/…`), so a local stand-in (`?levels=`) answers for
 * them too; null when the levels file's address is not of that shape.
 */
export function plusUrls(levelsUrl: string): { groups: string; triggers: string; groupsDay: (day: string) => string; triggersDay: (day: string) => string; rollup: { free: string; groups: string; triggers: string } } | null {
  const m = /^(.*)\/v1\/([a-z0-9]+)\/liquidations\.json$/.exec(levelsUrl);
  if (!m) return null;
  const base = `${m[1]}/v1/plus/${m[2]}`;
  return {
    groups: `${base}/liquidations-groups.json`, triggers: `${base}/triggers.json`,
    groupsDay: day => `${base}/liquidation-history-groups/${day}.json`, triggersDay: day => `${base}/trigger-history/${day}.json`,
    rollup: { free: `${base}/liquidation-history-4h.json`, groups: `${base}/liquidation-history-groups-4h.json`, triggers: `${base}/trigger-history-4h.json` },
  };
}

function urlFrom(search: string): string {
  const asked = new URLSearchParams(search).get('levels');
  if (asked) {
    try {
      const url = new URL(asked);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url.href;
    } catch { /* not a URL: the configured address stands */ }
  }
  return LIQ_LEVELS_URL;
}
