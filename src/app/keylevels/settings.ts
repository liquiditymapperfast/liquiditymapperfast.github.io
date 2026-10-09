import { PERIOD_KINDS, type PeriodKind, type PeriodLines } from './levels.ts';

/**
 * The Key levels' settings: whether they show, which lines of the day, the week and the month, whether an untouched previous level runs on,
 * and the labels at the lines' right ends and on the price axis. Days and weeks start in the Volume profile's zone (`traded.zone`), so the two
 * never disagree about when a day began.
 */
export interface KeyLevelSettings extends Record<PeriodKind, PeriodLines> {
  on: boolean;
  untouched: boolean;
  labels: boolean;
  tags: boolean;
}

const NONE: PeriodLines = { prev: false, mid: false, open: false, sofar: false };
/** Off until switched on; then the previous day's high, low and middle and today's open, the levels most people look at. */
export const KEY_LEVEL_DEFAULTS: Readonly<KeyLevelSettings> = {
  on: false, day: { prev: true, mid: true, open: true, sofar: false }, week: { ...NONE }, month: { ...NONE }, untouched: true, labels: true, tags: true,
};

const flag = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;

/** Settings from storage, field by field: whatever is missing or not valid falls back to the default. */
export function readKeyLevels(saved: unknown): KeyLevelSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof KeyLevelSettings, unknown>>, d = KEY_LEVEL_DEFAULTS;
  const lines = (period: PeriodKind): PeriodLines => {
    const x = (s[period] && typeof s[period] === 'object' ? s[period] : {}) as Partial<Record<keyof PeriodLines, unknown>>, def = d[period];
    return { prev: flag(x.prev, def.prev), mid: flag(x.mid, def.mid), open: flag(x.open, def.open), sofar: flag(x.sofar, def.sofar) };
  };
  return { on: flag(s.on, d.on), day: lines('day'), week: lines('week'), month: lines('month'), untouched: flag(s.untouched, d.untouched), labels: flag(s.labels, d.labels), tags: flag(s.tags, d.tags) };
}

/** Whether any line is chosen at all. */
export const anyLine = (s: KeyLevelSettings): boolean => PERIOD_KINDS.some(p => s[p].prev || s[p].mid || s[p].open || s[p].sofar);
