import type { Store } from '../store.ts';
import { el } from '../dom.ts';
import { heading, note, selectRow, switchRow } from '../ui.ts';
import { helpButton } from '../help.ts';
import { t } from '../i18n.ts';
import { clock, price as fmtPrice } from '../format.ts';
import { currentCoin } from '../coin.ts';
import { venueLabel } from '../venues.ts';
import { venueMark } from '../venue-marks.ts';
import { parsePick } from '../market-choice.ts';
import { MAX_VWAP_MARKETS, VWAP_PICKS, pickTarget, seedPicks } from '../vwap/markets.ts';
import { rowChoices } from './model.ts';
import { MAX_TPO_COUNT, TPO_BLOCKS, blockMsOf, editScope, withRows, type TpoSettings } from './settings.ts';

/**
 * What the map knows for the panel: the Auto row size for this coin (0 until its days are read), whose candles the TPO reads (the chart
 * market, and the chosen markets' names), the block's minutes, the markets whose history begins after the oldest window drawn, and since
 * when the other venues mark hollow blocks.
 */
export interface TpoInfo {
  auto: number; market: string | null; minutes: number; names?: string[]; short?: { name: string; from: number }[]; hollowFrom?: number;
  /** The oldest time the chart market's candles are kept from at this block length (null: none read). */
  keptFrom?: number | null;
  /** Whether the blocks come from chosen markets (a market reaching less far is then left out of older windows, not the whole TPO). */
  chosen?: boolean;
}

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
    selectRow(t('How many'), t('Every window in view, or the latest few up to the chart\'s right edge.'), [['0', t('All in view')], ...Array.from({ length: MAX_TPO_COUNT }, (_, k) => [String(k + 1), String(k + 1)] as [string, string])], String(s.count), v => set({ count: Number(v) })),
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
    switchRow(t('Hollow where one venue stood alone'), s.source === 'chosen' ? t('A row only one of the ticked markets reached, at least a row and 3 bp past where most of them stopped (each moved by its usual gap first), is drawn as an outline and not counted. Needs three markets or more.') : t('A block drawn as an outline where this market\'s wick went at least a row and 3 bp past where most of the market stopped, from the other venues switched on (each moved by its usual gap first). Rare on the largest markets, more common on smaller ones.'), s.hollow, hollow => set({ hollow })),
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
  candlesFrom(store, body, rebuild, i);
}

/**
 * Whose candles the blocks are made from: the chart market's (the default: the market on the chart, or the one standing in for it where its
 * history cannot be read), or markets ticked as the VWAP's (each exchange's spot and perpetual apart, at most `MAX_VWAP_MARKETS`; switched
 * to them, the boxes start from the chart market, so nothing changes until one is ticked); how far back they reach, and a market whose
 * history begins after the oldest window drawn.
 */
function candlesFrom(store: Store, body: HTMLElement, rebuild: () => void, i: TpoInfo): void {
  const s = store.state.tpo, coin = currentCoin(), chart = store.state.marketId;
  body.append(heading(t('Candles')), selectRow(t('Candles from'), t("Which markets' candles the blocks are made from."), [['chart', t('The chart market')], ['chosen', t('Chosen markets')]], s.source, v => {
    const source = v === 'chosen' ? 'chosen' : 'chart', now = store.state.tpo;
    store.set({ tpo: { ...now, source, picks: source === 'chosen' && !now.picks.length ? seedPicks(chart, coin) : now.picks } });
    rebuild();
  }));
  if (s.source === 'chart') {
    body.append(note(i.market ? t('From the candles of {market}, in blocks of {n} minutes.', { market: i.market, n: i.minutes }) : t('No market of this coin has a history the page can read, so there is no TPO.')));
    if (s.hollow && i.hollowFrom) body.append(note(t('Hollow blocks need the other venues\' candles, read back to {date}: older blocks are drawn without them.', { date: clock(i.hollowFrom, true) })));
  } else {
    body.append(note(t('Each block spans where most of the ticked markets\' volume traded, each moved by its usual gap to the chart market first; a row only one of them reached is drawn hollow (with three markets or more). More markets take longer to load; with none ticked there is no TPO.')));
    const list = el('div', { class: 'market-picker' }), boxes: HTMLInputElement[] = [];
    const sync = (): void => { const full = store.state.tpo.picks.length >= MAX_VWAP_MARKETS; for (const box of boxes) box.disabled = full && !box.checked; };
    // Every exchange and kind this coin is listed on, and a saved choice it is not, greyed.
    for (const pick of VWAP_PICKS.filter(p => pickTarget(p, coin, chart) || s.picks.includes(p))) {
      const parts = parsePick(pick)!, target = pickTarget(pick, coin, chart);
      const box = el('input', { type: 'checkbox', checked: s.picks.includes(pick) });
      box.onchange = () => {
        const kept = store.state.tpo.picks.filter(p => p !== pick);
        store.set({ tpo: { ...store.state.tpo, picks: box.checked ? [...kept, pick] : kept } });
        sync(); rebuild();
      };
      boxes.push(box);
      list.append(el('label', { class: `opt pick${target ? '' : ' missing'}`, tip: target?.id ?? '' }, box,
        el('span', { class: 'name' }, venueMark(target?.id ?? parts.family, 14), ` ${venueLabel(parts.family)} · ${parts.kind === 'spot' ? t('Spot') : t('Perpetual')}`),
        el('span', { class: 'desc', textContent: target ? target.listing.symbol : t('not listed for this coin here') })));
    }
    body.append(heading(t('Markets')), list);
    sync();
    if (s.picks.length >= MAX_VWAP_MARKETS) body.append(note(t('Up to six markets: untick one to choose another.')));
    if (i.names && i.names.length) body.append(note(t('From the candles of {markets}, in blocks of {n} minutes.', { markets: i.names.join(', '), n: i.minutes })));
  }
  // Kept as far back as a year of half hours: a block length read from finer candles (a session off the quarter hour) reaches less far.
  const kept = i.keptFrom ?? null;
  body.append(note(kept !== null && Date.now() - kept < 300 * 86_400_000 ? t('At this block length the candles reach back to {date}; scroll the chart back to see older windows.', { date: clock(kept, true) }) : t('Days and weeks reach back about thirteen months; scroll the chart back to see them.')));
  for (const m of i.short ?? []) body.append(note(i.chosen ? t('{market}: its history reaches back to {date} only, so older windows are drawn without it.', { market: m.name, date: clock(m.from, true) }) : t('{market}: its history reaches back to {date} only, so no TPO is drawn before it.', { market: m.name, date: clock(m.from, true) })));
}
