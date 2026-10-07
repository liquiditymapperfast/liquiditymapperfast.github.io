import { el } from './dom.ts';
import { compactBar } from './device.ts';
import { makeDraggable } from './drag.ts';
import { usd } from './format.ts';
import { COIN_VENUES, MIN_MARKETS, type Catalogue, type Coin } from '../shared/coins.ts';
import { currentCoin, loadCatalogue, sizeScale, switchCoin } from './coin.ts';
import { t } from './i18n.ts';

/** Rows drawn before the person types: enough to scroll through the largest coins, and the search finds the rest. */
const FIRST_ROWS = 60;

/** The coins whose name starts with what was typed first, then those that contain it, in the list's order (by volume). */
export function matchCoins(coins: readonly Coin[], query: string): Coin[] {
  const q = query.trim().toUpperCase();
  if (!q) return [...coins];
  return [...coins.filter(c => c.coin.startsWith(q)), ...coins.filter(c => !c.coin.startsWith(q) && c.coin.includes(q))];
}

/** "×0.1", "×0.04": how a coin's size settings compare with BTC's. */
export const scaleText = (scale: number): string => `×${Number(scale.toPrecision(2))}`;

/**
 * The coin picker: the coins on most of the markets, largest first, with a search. Choosing one loads the page again on it (app/coin.ts),
 * so nothing here changes the running page.
 */
export async function openCoinDialog(): Promise<void> {
  const dialog = el('dialog', { class: 'venues coins' });
  const close = el('button', { textContent: t('Close'), onclick: () => dialog.close() });
  dialog.append(el('h3', { textContent: t('Coin') }), el('p', { class: 'muted', textContent: t('Loading…') }));
  document.body.append(dialog); dialog.showModal();
  const drag = makeDraggable(dialog, { grabs: target => target.closest('h3') !== null, enabled: () => !compactBar(), size: () => ({ width: dialog.offsetWidth, need: dialog.offsetHeight }) });
  const keepInside = (): void => drag.clamp();
  window.addEventListener('resize', keepInside);
  dialog.addEventListener('close', () => { window.removeEventListener('resize', keepInside); dialog.remove(); });

  const list: Catalogue = await loadCatalogue();
  if (!dialog.isConnected) return;
  const here = currentCoin().coin, total = COIN_VENUES.length;
  const search = el('input', { type: 'search', placeholder: t('Search coins'), ariaLabel: t('Search coins'), autocomplete: 'off', spellcheck: false });
  const rows = el('div', { class: 'coin-list', role: 'listbox' });
  const row = (c: Coin): HTMLElement => el('button', { type: 'button', class: c.coin === here ? 'coin-row on' : 'coin-row', role: 'option', ariaSelected: String(c.coin === here), onclick: () => { dialog.close(); switchCoin(c.coin); } },
    el('span', { class: 'coin-name', textContent: c.coin }),
    el('span', { class: 'muted', textContent: t('{n} of {total} markets', { n: Object.keys(c.markets).length, total }) }),
    el('span', { class: 'muted coin-volume', textContent: c.volumeUsd > 0 ? `$${usd(c.volumeUsd)}` : '' }));
  const show = (): void => {
    const found = matchCoins(list.coins, search.value), shown = search.value.trim() ? found : found.slice(0, FIRST_ROWS);
    rows.replaceChildren(...(shown.length ? shown.map(row) : [el('p', { class: 'muted', textContent: t('No coin matches.') })]));
  };
  search.oninput = show;
  // Enter takes the best match, so typing a name and pressing Enter is enough.
  search.onkeydown = event => { if (event.key !== 'Enter') return; const first = matchCoins(list.coins, search.value)[0]; if (first) { dialog.close(); switchCoin(first.coin); } };
  show();

  const notes: HTMLElement[] = [];
  if (list.coins.length > 1) {
    const built = list.builtAt > 0 ? new Date(list.builtAt).toISOString().slice(0, 10) : '';
    notes.push(el('p', { class: 'muted', textContent: t('Coins on at least {min} of the {total} markets, largest 24 h volume first. List of {date}.', { min: MIN_MARKETS, total, date: built }) }));
  } else notes.push(el('p', { class: 'muted', textContent: t('The coin list could not be read, so only BTC is offered.') }));
  if (here !== 'BTC') notes.push(el('p', { class: 'muted', textContent: t("Size settings (trade bubbles, absorption, sounds, size rows) follow the coin's volume: on {coin} they are {factor} of BTC's.", { coin: here, factor: scaleText(sizeScale()) }) }));
  dialog.replaceChildren(el('h3', { textContent: t('Coin') }), search, rows, ...notes, el('div', { class: 'row' }, close));
  if (!compactBar()) search.focus();
}
