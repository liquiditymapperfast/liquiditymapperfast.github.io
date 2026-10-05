import { el } from './dom.ts';
import type { VenueEntry } from './source.ts';

/** What a venue chip or row says when the exchange refuses this visitor's location. */
export const VPN_HINT = 'unavailable from your location — a VPN set to another country may enable it';

/** The venues a person chose that their location cannot reach. */
export function blockedVenues(venues: readonly VenueEntry[]): VenueEntry[] { return venues.filter(v => v.selected && v.state === 'blocked'); }

/** "Binance", "Binance and Bybit", "Binance, Bybit and OKX". */
export function nameList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The sentence for the banner, or null when every chosen venue is reachable. */
export function noticeText(blocked: readonly VenueEntry[]): string | null {
  if (!blocked.length) return null;
  const many = blocked.length > 1;
  return `${nameList(blocked.map(v => v.name))} ${many ? 'are' : 'is'} unavailable from your location. A VPN set to another country may enable ${many ? 'them' : 'it'}.`;
}

/**
 * A banner for venues the person's country cannot reach. It can be dismissed, and comes back only when a different set of venues is
 * blocked (or the same one is blocked again after being reachable), so it never nags about a decision already made.
 */
export class VenueNotice {
  readonly root = el('div', { class: 'notice', role: 'status', hidden: true });
  readonly #text = el('span');
  #dismissed = '';

  constructor() {
    this.root.append(el('span', { class: 'notice-mark', textContent: '⊘', ariaHidden: 'true' }), this.#text,
      el('button', { class: 'notice-close', textContent: '×', tip: 'Dismiss', ariaLabel: 'Dismiss', onclick: () => { this.#dismissed = this.#key; this.root.hidden = true; } }));
  }

  #key = '';

  update(venues: readonly VenueEntry[]): void {
    const blocked = blockedVenues(venues), text = noticeText(blocked);
    this.#key = blocked.map(v => v.id).sort().join(',');
    // A set that is no longer blocked clears the dismissal, so a later block is announced again.
    if (!text) this.#dismissed = '';
    this.root.hidden = !text || this.#dismissed === this.#key;
    if (text && this.#text.textContent !== text) this.#text.textContent = text;
  }
}
