import type { Store } from '../store.ts';
import { heading, note, numberRow, selectRow, switchRow } from '../ui.ts';
import { helpButton } from '../help.ts';
import { t } from '../i18n.ts';
import { scaledUsd, unscaledUsd } from '../coin.ts';
import type { StatOptions } from '../stat-options.ts';
import type { FootprintSettings } from './settings.ts';

/**
 * The Footprint panel: its first row shows or hides the footprint (and the bar statistics under the map); then what each row prints, and the
 * imbalances: whether diagonal ones are outlined, and the ratio, minimum, empty-row rule and stacked rows, which are the bar statistics' too.
 */
export function buildFootprintPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void): void {
  const fp = store.state.footprint, o = store.state.barStatOptions;
  const set = (change: Partial<FootprintSettings>): void => { store.set({ footprint: { ...store.state.footprint, ...change } }); };
  const setOptions = (change: Partial<StatOptions>): void => { store.set({ barStatOptions: { ...store.state.barStatOptions, ...change } }); };
  tools.append(helpButton('footprint'));
  body.append(
    switchRow(t('Show the footprint'), t('Zoom in on the candles to see, at each price, what was sold and bought at market; the bar statistics show under the map.'), store.state.show.footprint, on => { store.set({ show: { ...store.state.show, footprint: on } }); rebuild(); }),
    heading(t('Cells')),
    selectRow(t('Numbers'), t('What each row prints once the candles are wide enough.'), [['split', t('Sold × bought')], ['delta', t('Delta')], ['total', t('Total')], ['none', t('None')]], fp.text, v => set({ text: v === 'delta' || v === 'total' || v === 'none' ? v : 'split' })),
    heading(t('Imbalances')),
    switchRow(t('Mark diagonal imbalances'), t('Outline a row\'s sells where they are at least the ratio times the buys one row up, and its buys against the sells one row down.'), fp.diagonal, diagonal => set({ diagonal })),
    numberRow(t('Imbalance ratio'), t('A level counts as imbalanced when its volume is at least this many times the opposite volume one row away'), { min: 1, step: 0.5, value: o.imbRatio }, v => setOptions({ imbRatio: Math.max(1, v) })),
    numberRow(t('Imbalance min USD'), t('Ignore imbalanced levels smaller than this'), { min: 0, step: scaledUsd(1000), value: scaledUsd(o.imbMinUsd) }, v => setOptions({ imbMinUsd: unscaledUsd(Math.max(0, v)) })),
    switchRow(t('Count against an empty row'), t('A row beside one where nothing traded, inside the candle, counts as imbalanced however small it is (from the minimum).'), o.imbZeros, imbZeros => setOptions({ imbZeros })),
    numberRow(t('Stacked rows'), t('Adjacent imbalanced rows on one side that count as a stack'), { min: 2, step: 1, value: o.stackedN }, v => setOptions({ stackedN: Math.max(2, Math.round(v)) })),
    note(t('The ratio, the minimum and the stacked rows are the bar statistics\' too. Imbalances are read on the rows shown: zooming changes the row size, and with it which rows stand out.')),
    heading(t('Running on')),
    switchRow(t('Stacked imbalance zones'), t('A band where a closed candle stacked imbalances on one side (support from buys, resistance from sells), until a later candle trades into it.'), fp.zones, zones => set({ zones })),
    switchRow(t('Untouched points of control'), t('Each closed candle\'s busiest row, dotted to the right edge while no later candle has traded through it.'), fp.nakedPoc, nakedPoc => set({ nakedPoc })),
    note(t('Both show while the footprint does, and whether a later candle reached them is read from the candles of the market on the chart.')),
  );
}
