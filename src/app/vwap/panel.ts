import type { Store } from '../store.ts';
import { el } from '../dom.ts';
import { heading, note, selectRow, switchRow } from '../ui.ts';
import { helpButton } from '../help.ts';
import { t } from '../i18n.ts';
import { clock, usd } from '../format.ts';
import { currentCoin, scaledUsd } from '../coin.ts';
import { WHALE_BANDS_USD } from '../../shared/print-sums.ts';
import { venueLabel } from '../venues.ts';
import { historyTarget } from '../keylevels/history.ts';
import { MAX_ANCHORS, anchorsOf, withoutAnchor, type VwapSettings } from './settings.ts';

/** What the page knows of the whale sums: where the recording's count of large orders begins, whether the source has them, which source it is. */
export interface WhaleInfo { since: number | null; state: 'ready' | 'unavailable'; browser: boolean }

/**
 * The VWAP panel: its first row switches the lines on and off; the session VWAP (what it restarts at, its bands); the anchored ones (each with
 * its start and a remove button, and a button that arms the next click on the map to place one); the whale VWAP (its size, and since when the
 * large orders are recorded); labels and axis tags; whose candles they come from.
 */
export function buildVwapPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, whale: () => WhaleInfo | null = () => null): void {
  const s = store.state.vwap, coin = currentCoin().coin, now = Date.now();
  const set = (change: Partial<VwapSettings>, again = false): void => { store.set({ vwap: { ...store.state.vwap, ...change } }); if (again) rebuild(); };
  tools.append(helpButton('vwap'));
  body.append(
    switchRow(t('Show VWAP'), t('The average price the market traded at, weighted by volume, as lines across the map.'), s.on, on => set({ on }, true)),
    heading(t('Session')),
    switchRow(t('Session VWAP'), t('Starts again at each day, week or month, in the zone the Volume profile and Key levels use.'), s.session, session => set({ session })),
    selectRow(t('Starts again each'), t('The stretch the average is taken over.'), [['day', t('Day')], ['week', t('Week')], ['month', t('Month')]], s.period, v => set({ period: v === 'week' || v === 'month' ? v : 'day' })),
    selectRow(t('Bands'), t('Lines one and two standard deviations either side: how far prices spread around the average, weighted by volume.'), [['0', t('None')], ['1', '±1σ'], ['2', '±1σ ±2σ']], String(s.bands), v => set({ bands: v === '1' ? 1 : v === '2' ? 2 : 0 })),
    heading(t('Anchored VWAP')),
    note(t('The average from a moment you choose up to now: from a low, a high or the candle of a news event.')),
  );
  const anchors = anchorsOf(s, coin, now);
  anchors.forEach((at, i) => {
    const remove = el('button', { type: 'button', class: 'session-remove', ariaLabel: t('Remove'), tip: t('Remove this anchor'), onclick: () => { store.set({ vwap: withoutAnchor(store.state.vwap, coin, at) }); rebuild(); } });
    body.append(el('div', { class: 'session-row vwap-anchor' }, el('span', { class: 'name', textContent: `${t('AVWAP')} ${i + 1}` }), el('span', { class: 'desc', textContent: clock(at, true) }), remove));
  });
  const armed = store.state.vwapAnchoring, full = anchors.length >= MAX_ANCHORS;
  const place = el('button', { type: 'button', textContent: armed ? t('Cancel') : t('Place an anchor'), disabled: full && !armed,
    tip: full ? t('Up to four anchors: remove one first.') : t('Then click the map where the average should start.'),
    onclick: () => { store.set(armed ? { vwapAnchoring: false } : { vwapAnchoring: true, rangeTool: false }); rebuild(); } });
  body.append(el('div', { class: 'session-add' }, place));
  if (armed) body.append(note(t('Click the map where the average should start.')));
  body.append(
    heading(t('Whale VWAP')),
    switchRow(t('Whale VWAP'), t('The average price the large market orders paid since the session began: buys in the buy colour, sells in the sell colour.'), s.whale, on => set({ whale: on }, true)),
    selectRow(t('Orders from'), t('Only market orders at least this large are averaged, on the exchanges switched on.'), WHALE_BANDS_USD.map(b => [String(b), `$${usd(scaledUsd(b))}`] as [string, string]), String(s.whaleUsd), v => set({ whaleUsd: Number(v) })),
  );
  const info = whale();
  if (s.whale && info) {
    if (info.state === 'unavailable') body.append(note(info.browser ? t('The orders could not be read just now; trying again in a minute.') : t('This server does not keep whale sums yet: it needs restarting with the new version.')));
    else if (info.since !== null) body.append(note(t('Large orders are recorded since {time}: on a longer session the whale lines start there.', { time: clock(info.since, true) })));
    if (info.browser) body.append(note(t('This page reads the exchanges itself: it counts the orders it has recorded in this browser.')));
  }
  body.append(
    switchRow(t('Labels'), t('Each line\'s name and price at its right end, where there is room.'), s.labels, labels => set({ labels })),
    switchRow(t('Tags on the price axis'), t('The name of each line that reaches the right edge, beside its price.'), s.tags, tags => set({ tags })),
  );
  const target = historyTarget(store.state.marketId, currentCoin());
  if (!target) { body.append(note(t('No market of this coin has a history the page can read, so there is no VWAP.'))); return; }
  body.append(note(t('From the candles of {market}: each bar\'s typical price (high, low and close) weighted by its volume, a minute at a time for a day and coarser for longer.', { market: `${venueLabel(target.id)} ${target.listing.symbol}` })));
  if (!target.own) body.append(note(t('The market on the chart has no history the page can read, so another market of the coin is used; its prices can differ a little.')));
}
