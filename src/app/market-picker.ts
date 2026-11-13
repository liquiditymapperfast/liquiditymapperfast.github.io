import type { Store } from './store.ts';
import type { FlowBook } from './flow-book.ts';
import { el } from './dom.ts';
import { t } from './i18n.ts';
import { venueLabel } from './venues.ts';
import { venueMark } from './venue-marks.ts';
import { heading, note, selectRow } from './ui.ts';
import { MAX_PICKS, pickOptions, type CustomMarkets, type PickOption } from './market-choice.ts';
import { bookPickOptions } from './book-markets.ts';

/**
 * The list of markets a person picks from (market-choice.ts): one row per exchange and kind this coin has, with the exchange's mark, the kind
 * and the market it stands for here; a pick kept that this coin or source has no market for stays in the list, greyed, so it can be seen and
 * taken off. At most `MAX_PICKS` are picked: the boxes not ticked are disabled at that count.
 */
export function marketPicker(store: Store, flow: FlowBook | null, list: keyof CustomMarkets): HTMLElement {
  const oi = list === 'oi', picked = (): string[] => store.state.customMarkets[list];
  return pickList(pickOptions(store.state, flow, picked(), oi), picked, picks => store.set({ customMarkets: { ...store.state.customMarkets, [list]: picks } }),
    oi ? t('No perpetual of an exchange whose open interest is read is listed yet.') : t('No market is listed yet.'));
}

/** The same list for order books (book-markets.ts): a row for each exchange and kind with a book on this coin, whatever the venue chips say. */
export function bookPicker(store: Store, ticked?: (picks: readonly string[]) => void): HTMLElement {
  return pickList(bookPickOptions(store.state, store.state.bookPicks), () => store.state.bookPicks, picks => { ticked?.(picks); store.set({ bookPicks: picks }); }, t('No order book is listed yet.'));
}

function pickList(options: readonly PickOption[], picked: () => readonly string[], put: (picks: string[]) => void, none: string): HTMLElement {
  const root = el('div', { class: 'market-picker' });
  const boxes: HTMLInputElement[] = [];
  const sync = (): void => { const full = picked().length >= MAX_PICKS; for (const box of boxes) box.disabled = full && !box.checked; };
  for (const option of options) {
    const box = el('input', { type: 'checkbox', checked: picked().includes(option.pick) });
    box.onchange = () => {
      const now = picked().filter(p => p !== option.pick);
      put(box.checked ? [...now, option.pick] : now);
      sync();
    };
    boxes.push(box);
    const kind = option.kind === 'spot' ? t('Spot') : t('Perpetual');
    const where = option.id ? option.id.split(':').slice(1).filter(s => s !== 'spot').join(':') : t('not listed for this coin here');
    root.append(el('label', { class: `opt pick${option.id ? '' : ' missing'}`, tip: option.id ?? '' }, box,
      el('span', { class: 'name' }, venueMark(option.id ?? option.family, 14), ` ${venueLabel(option.family)} · ${kind}`),
      el('span', { class: 'desc', textContent: where })));
  }
  if (!boxes.length) root.append(note(none));
  sync();
  return root;
}

/**
 * The open-interest markets' panel (opened from the OI pane and, with NL/NS shown, the Delta pane): whose open interest the OI pane, the bar
 * statistics' oi chg row, NL/NS and the Long/Short pane count, and the picker when they are picked.
 */
export function buildOiMarketsPanel(store: Store, flow: FlowBook, body: HTMLElement, rebuild: () => void): void {
  const mode = store.state.oiMarkets;
  body.append(
    selectRow(t('Count'), t('Whose open interest the OI pane, the bar statistics, NL/NS and the Long/Short pane count.'),
      [['all', t('All perpetuals')], ['chart', t('The chart market')], ['custom', t('Chosen markets')]], mode,
      v => { store.set({ oiMarkets: v === 'chart' || v === 'custom' ? v : 'all' }); rebuild(); }),
    note(mode === 'custom' ? t('The perpetuals ticked below are added together whatever the venue chips and the Spot / Perp filter say. With none ticked, none is counted.')
      : mode === 'all' ? t('All perpetuals adds the perpetuals of every venue switched on, on an exchange whose open interest is read, whatever the Spot / Perp filter says: spot markets have no open interest.')
      : t('The chart market alone, or a reference market standing in where it has no open interest (the pane says which).')),
  );
  if (mode === 'custom') body.append(heading(t('Markets')), marketPicker(store, flow, 'oi'));
}

/**
 * The order books' panel (opened from the Depth pane and the Liquidity Tracker, which share the choice): whose books the two panes and their
 * sounds add up, and the picker when they are picked.
 */
export function buildBookMarketsPanel(store: Store, body: HTMLElement, rebuild: () => void, ticked?: (picks: readonly string[]) => void): void {
  const mode = store.state.bookMarkets;
  body.append(
    selectRow(t('Count'), t('Whose order books the Depth pane, the Liquidity Tracker and their sounds add up.'),
      [['all', t('All switched on')], ['chart', t('The chart market')], ['custom', t('Chosen markets')]], mode,
      v => { store.set({ bookMarkets: v === 'chart' || v === 'custom' ? v : 'all' }); rebuild(); }),
    note(mode === 'custom' ? t('The books ticked below are added up whatever the venue chips and the Spot / Perp filter say. With none ticked, none is counted.')
      : mode === 'all' ? t('All switched on adds up the book of every venue whose chip is on, inside the Spot / Perp filter.')
      : t('The chart market\'s own book alone: the same exchange, spot or perpetual as the chart, whatever the venue chips and the Spot / Perp filter say.')),
  );
  if (mode === 'custom') body.append(heading(t('Markets')), bookPicker(store, ticked));
}
