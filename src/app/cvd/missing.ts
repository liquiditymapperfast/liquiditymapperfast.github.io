import type { AppState, Scope } from '../store.ts';
import { inScope } from '../scope.ts';
import { familyKey, venueOfInstrument } from './families.ts';
import { t } from '../i18n.ts';

/**
 * Why an exchange that has recorded flow is not a row of the flow column: the Spot / Perp filter leaves it out, its chip is switched off,
 * it has no order book on the map, or it has not traded in the window the rows are ranked over. A column shorter than a person expects has
 * to say why, or it looks like rows that went missing. One past the number of rows a person asked for is not named: they chose the number.
 */
export type MissingWhy = 'filter' | 'off' | 'nobook' | 'quiet';
export interface Missing { key: string; why: MissingWhy; /** The venues of this exchange, for switching them back on. */ venues: string[] }

type State = Pick<AppState, 'markets' | 'disabledVenues' | 'scope' | 'levels'>;

/**
 * The exchanges in `withFlow` (instrument ids that have recorded flow) that are not among the `shown` family keys, each with its reason.
 * `volume` is an instrument's USD volume over the ranking window. An exchange held back by more than one thing gets the one that is easiest
 * to undo: the filter, then the chip, then the missing book.
 */
export function explainMissing(state: State, withFlow: readonly string[], shown: ReadonlySet<string>, volume: (id: string) => number): Missing[] {
  const drawn = state.levels ? new Set(state.levels.books.map(book => book.venue)) : null;
  const families = new Map<string, string[]>();
  for (const id of withFlow) { const key = familyKey(venueOfInstrument(id)), list = families.get(key); if (list) list.push(id); else families.set(key, [id]); }
  const out: Missing[] = [];
  for (const [key, ids] of families) {
    if (shown.has(key)) continue;
    const blocked = (id: string): MissingWhy | null => {
      const venue = venueOfInstrument(id);
      if (state.disabledVenues.includes(venue)) return 'off';
      if (drawn && !drawn.has(venue)) return 'nobook';
      if (!inScope(state.scope, state.markets, id)) return 'filter';
      return null;
    };
    const venues = [...new Set(ids.map(venueOfInstrument))], open = ids.filter(id => blocked(id) === null);
    if (open.length) { if (!open.some(id => volume(id) > 0)) out.push({ key, why: 'quiet', venues }); continue; }
    const reasons = ids.map(blocked);
    out.push({ key, venues, why: (['filter', 'off', 'nobook'] as const).find(why => reasons.includes(why))! });
  }
  return out;
}

/** What a notice row's button does. */
export type NoticeAction = { kind: 'both' } | { kind: 'on'; venues: string[] };
export interface NoticeRow { text: string; /** Everything the row names, for its tooltip when the line is cut short. */ full: string; action?: { label: string; run: NoticeAction } }

const NAMES_SHOWN = 6;

/**
 * The words for `missing`, one row per reason, the one a person can undo with a click first. `label` writes an exchange's name and `scope`
 * is the filter that is on.
 */
export function noticeRows(missing: readonly Missing[], label: (key: string) => string, scope: Scope): NoticeRow[] {
  const by = (why: MissingWhy): Missing[] => missing.filter(m => m.why === why);
  const names = (list: readonly Missing[], limit = NAMES_SHOWN): string => { const all = list.map(m => label(m.key)); return all.length > limit ? `${all.slice(0, limit).join(', ')}, …` : all.join(', '); };
  const full = (list: readonly Missing[]): string => list.map(m => label(m.key)).join(', ');
  const rows: NoticeRow[] = [];
  const filter = by('filter');
  if (filter.length) {
    const text = t('Hidden by the {kind} filter: {names}.', { kind: scope === 'spot' ? t('Spot') : t('Perp'), names: names(filter) });
    rows.push({ text, full: t('Hidden by the {kind} filter: {names}.', { kind: scope === 'spot' ? t('Spot') : t('Perp'), names: full(filter) }), action: { label: t('Show both'), run: { kind: 'both' } } });
  }
  const off = by('off');
  if (off.length) rows.push({ text: t('Switched off: {names}.', { names: names(off) }), full: t('Switched off: {names}.', { names: full(off) }), action: { label: t('Turn on'), run: { kind: 'on', venues: [...new Set(off.flatMap(m => m.venues))] } } });
  const quiet = by('quiet');
  if (quiet.length) rows.push({ text: t('No trades in this window: {names}.', { names: names(quiet) }), full: t('No trades in this window: {names}.', { names: full(quiet) }) });
  const nobook = by('nobook');
  if (nobook.length) rows.push({ text: t('Not on the map yet (no order book): {names}.', { names: names(nobook) }), full: t('Not on the map yet (no order book): {names}.', { names: full(nobook) }) });
  return rows;
}
