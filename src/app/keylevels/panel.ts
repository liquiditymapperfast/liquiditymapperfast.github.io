import type { Store } from '../store.ts';
import { el } from '../dom.ts';
import { heading, note, selectRow, switchRow } from '../ui.ts';
import { helpButton } from '../help.ts';
import { t } from '../i18n.ts';
import { venueLabel } from '../venues.ts';
import { currentCoin } from '../coin.ts';
import { ZONES } from '../traded/settings.ts';
import { PERIOD_KINDS, type PeriodKind, type PeriodLines } from './levels.ts';
import { historyTarget, type KeyLevelHistory } from './history.ts';
import { codeOf } from './paint.ts';
import type { KeyLevelSettings } from './settings.ts';

const PERIOD_NAMES: Readonly<Record<PeriodKind, string>> = { day: t('Day'), week: t('Week'), month: t('Month') };
/** The rows of the grid: which line, what it is, and its codes (the day's, as an example). */
const ROWS: readonly { key: keyof PeriodLines; name: string; desc: string; codes: string }[] = [
  { key: 'prev', name: t('Previous high and low'), desc: t('Where the previous period traded highest and lowest, across the one after it.'), codes: `${codeOf({ period: 'day', what: 'high', prev: true })} ${codeOf({ period: 'day', what: 'low', prev: true })}` },
  { key: 'mid', name: t('Previous middle'), desc: t('Halfway between the previous period\'s high and low.'), codes: codeOf({ period: 'day', what: 'mid', prev: true }) },
  { key: 'open', name: t('Open'), desc: t('Where each period opened, across it.'), codes: codeOf({ period: 'day', what: 'open', prev: false }) },
  { key: 'sofar', name: t('High and low so far'), desc: t('How high and how low the period under way has traded, moving as it does.'), codes: `${codeOf({ period: 'day', what: 'high', prev: false })} ${codeOf({ period: 'day', what: 'low', prev: false })}` },
];

/**
 * The Key levels panel: its first row switches them on and off; then which lines of the day, the week and the month (a grid of boxes), the zone
 * their days start in (the Volume profile's, shared), whether an untouched level runs on, labels and axis tags, and whose candles they come from.
 */
export function buildKeyLevelPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, history: KeyLevelHistory | null): void {
  const s = store.state.keyLevels;
  const set = (change: Partial<KeyLevelSettings>, again = false): void => { store.set({ keyLevels: { ...store.state.keyLevels, ...change } }); if (again) rebuild(); };
  tools.append(helpButton('keyLevels'));
  const grid = el('div', { class: 'keylevel-grid', role: 'group', ariaLabel: t('Lines') }, el('span'), ...PERIOD_KINDS.map(p => el('span', { class: 'head', textContent: PERIOD_NAMES[p] })));
  for (const row of ROWS) {
    grid.append(el('span', { class: 'what', tip: row.desc }, el('span', { class: 'name', textContent: row.name }), el('span', { class: 'desc', textContent: row.codes })));
    for (const p of PERIOD_KINDS) {
      const box = el('input', { type: 'checkbox', checked: s[p][row.key], ariaLabel: t('{line}, {period}', { line: row.name, period: PERIOD_NAMES[p] }) });
      box.onchange = () => set({ [p]: { ...store.state.keyLevels[p], [row.key]: box.checked } });
      grid.append(el('label', { tip: `${row.name} · ${PERIOD_NAMES[p]}` }, box));
    }
  }
  body.append(
    switchRow(t('Show key levels'), t('The previous day\'s, week\'s and month\'s high, low and middle, and where the one under way opened, as lines across the map.'), s.on, on => set({ on }, true)),
    heading(t('Lines')), grid,
    selectRow(t('Days start in'), t('The time zone whose midnight starts a day, whose Monday a week and whose 1st a month. The Volume profile\'s days and weeks use the same one.'),
      ZONES.map(z => [z.zone, z.label] as [string, string]), store.state.traded.zone, zone => store.set({ traded: { ...store.state.traded, zone } })),
    switchRow(t('Run on until reached'), t('A previous high, low or middle that the next period never traded through stays on, dotted, until price reaches it.'), s.untouched, untouched => set({ untouched })),
    switchRow(t('Labels'), t('Each line\'s name and price at its right end, where there is room.'), s.labels, labels => set({ labels })),
    switchRow(t('Tags on the price axis'), t('The name of each line that reaches the right edge, beside its price.'), s.tags, tags => set({ tags })),
  );
  const target = historyTarget(store.state.marketId, currentCoin().markets);
  if (!target) { body.append(note(t('No market of this coin has a history the page can read, so there are no key levels.'))); return; }
  body.append(note(t('From the hourly candles of {market}, about two months of them.', { market: `${venueLabel(target.id)} ${target.listing.symbol}` })));
  if (!target.own) body.append(note(t('The market on the chart has no history the page can read, so another market of the coin is used; its prices can differ a little.')));
  if (history?.id === target.id && history.state === 'unavailable') body.append(note(t('Its history could not be read just now; trying again in a minute.')));
}
