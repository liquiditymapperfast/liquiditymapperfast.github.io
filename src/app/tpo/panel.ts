import type { Store } from '../store.ts';
import { el } from '../dom.ts';
import { heading, note, selectRow, switchRow } from '../ui.ts';
import { helpButton } from '../help.ts';
import { t } from '../i18n.ts';
import { price as fmtPrice } from '../format.ts';
import { currentCoin } from '../coin.ts';
import { rowChoices } from './model.ts';
import { MAX_TPO_COUNT, TPO_BLOCKS, blockMsOf, editScope, withRows, type TpoSettings } from './settings.ts';

/** What the map knows for the panel: the Auto row size for this coin (0 until its days are read) and whose candles the TPO reads. */
export interface TpoInfo { auto: number; market: string | null; minutes: number }

/**
 * The TPO panel, in the order a person decides: whether it shows; which windows and how many (the zone and the sessions are the Volume
 * profile's); how long a block is and how tall a row; how it is drawn (blocks or letters, coloured by time or by how full a row is, folded or
 * laid out in time); what is marked on it; whether the Volume profile's lines follow it; the hollow blocks; and the windows split or merged.
 */
export function buildTpoPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, info: () => TpoInfo = () => ({ auto: 0, market: null, minutes: 30 })): void {
  const s = store.state.tpo, coin = currentCoin().coin, i = info();
  const set = (change: Partial<TpoSettings>, again = false): void => { store.set({ tpo: { ...store.state.tpo, ...change } }); if (again) rebuild(); };
  tools.append(helpButton('tpo'));
  body.append(
    switchRow(t('Show TPO'), t('Time Price Opportunity: each half hour of a day stacked at the prices it traded at, so the day\'s shape shows where the market spent its time.'), s.on, on => set({ on }, true)),
    selectRow(t('Windows'), t('Each day or week in the zone the Volume profile uses, or its sessions (set in the Volume profile panel).'), [['day', t('Day')], ['week', t('Week')], ['sessions', t('Sessions')]], s.period, v => set({ period: v === 'week' || v === 'sessions' ? v : 'day' }, true)),
    selectRow(t('How many'), t('The latest windows up to the chart\'s right edge.'), Array.from({ length: MAX_TPO_COUNT }, (_, k) => [String(k + 1), String(k + 1)] as [string, string]), String(s.count), v => set({ count: Number(v) })),
    selectRow(t('Block'), t('How long each letter stands for: half an hour for a day or a session, four hours for a week.'), TPO_BLOCKS.map(m => [String(m), m === 0 ? t('By the window') : m < 60 ? t('{n} min', { n: m }) : t('{n} h', { n: m / 60 })] as [string, string]), String(s.block), v => set({ block: Number(v) }, true)),
  );
  const auto = i.auto, chosen = s.rows[coin] ?? 0;
  const options: [string, string][] = [['0', auto > 0 ? t('Auto ({price})', { price: fmtPrice(auto) }) : t('Auto')], ...rowChoices(auto > 0 ? auto : chosen || 1).filter(r => auto > 0 || chosen > 0).map(r => [String(r), fmtPrice(r)] as [string, string])];
  if (chosen > 0 && !options.some(([v]) => Number(v) === chosen)) options.push([String(chosen), fmtPrice(chosen)]);
  body.append(selectRow(t('Rows'), t('The price each row spans. Auto: about 90 rows across a typical day of this coin (its last two weeks), where the calls held best; kept for this coin.'), options, String(chosen), v => { store.set({ tpo: withRows(store.state.tpo, coin, Number(v)) }); rebuild(); }));
  body.append(
    heading(t('Look')),
    selectRow(t('Draw as'), t('Letters while a block is tall enough to hold one, blocks below that (Auto), or always one of the two.'), [['auto', t('Auto')], ['blocks', t('Blocks')], ['letters', t('Letters')]], s.look, v => set({ look: v === 'blocks' || v === 'letters' ? v : 'auto' })),
    selectRow(t('Colour'), t('By the time of each block, early warm to late cool; or by how many blocks its row holds.'), [['time', t('By time')], ['count', t('By row length')]], s.colour, v => set({ colour: v === 'count' ? 'count' : 'time' })),
    switchRow(t('Laid out in time'), t('Each block in its own column at its half hour, behind its own candles, instead of folded into the profile (U).'), s.unfold, unfold => set({ unfold })),
    selectRow(t('Value area'), t('The share of the TPOs around the point of control that the value area holds.'), ['60', '65', '68', '70', '75', '80'].map(v => [v, `${v} %`] as [string, string]), String(s.share), v => set({ share: Number(v) })),
    heading(t('Marks')),
    switchRow(t('Initial balance, open and last'), t('The range of the first hour\'s blocks (the first block where a block is an hour or longer) as a bracket at the left (IBH, IBL), the window\'s first price and its last.'), s.ib, ib => set({ ib })),
    switchRow(t('Tails, poor extremes, single prints'), t('Two or more rows of one block at an extreme make a tail; a top or bottom row of two or more blocks is poor. Each call says how many of four row grids agree: moving the rows by part of a row changes these calls on many days.'), s.calls, calls => set({ calls })),
    switchRow(t('Numbers under each profile'), t('Its range, its initial balance, its TPOs above and below the point of control, and its volume.'), s.stats, stats => set({ stats })),
    switchRow(t('Hollow where one venue stood alone'), t('A block drawn as an outline where this market\'s wick went at least a row and 3 bp past where most of the market stopped, from the other venues switched on (each moved by its usual gap first). Rare on the largest markets, more common on smaller ones.'), s.hollow, hollow => set({ hollow })),
    switchRow(t('Volume profile lines follow the TPO'), t('While the TPO shows, the Volume profile\'s lines of the same windows (point of control, value area, carried and untouched) are drawn at the TPO\'s levels, so there is one set of lines. With them off, the TPO draws its own point of control.'), s.lines, lines => set({ lines })),
    heading(t('Split and merge')),
    note(t('Right-click a block to split its window there, or to merge it with the window before or after.')),
  );
  // Edits belong to this coin, kind of window and block length: undone here for those alone.
  const scope = editScope(coin, s.period, blockMsOf(s)), edits = (s.splits[scope]?.length ?? 0) + (s.merges[scope]?.length ?? 0);
  if (edits) body.append(el('div', { class: 'session-add' }, el('button', { type: 'button', textContent: t('Undo splits and merges'), onclick: () => {
    const { [scope]: _s, ...splits } = store.state.tpo.splits, { [scope]: _m, ...merges } = store.state.tpo.merges;
    store.set({ tpo: { ...store.state.tpo, splits, merges } }); rebuild();
  } })));
  body.append(note(i.market ? t('From the candles of {market}, in blocks of {n} minutes.', { market: i.market, n: i.minutes }) : t('No market of this coin has a history the page can read, so there is no TPO.')));
}
