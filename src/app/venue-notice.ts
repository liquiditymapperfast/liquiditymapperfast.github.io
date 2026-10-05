import { el } from './dom.ts';
import type { VenueEntry } from './source.ts';

/** What a venue chip or row says when the exchange refuses this visitor's location. */
export const VPN_HINT = 'unavailable from your location — a VPN set to another country may enable it';

/** The venues a person chose that their location cannot reach. */
export function blockedVenues(venues: readonly VenueEntry[]): VenueEntry[] { return venues.filter(v => v.selected && v.state === 'blocked'); }

/** What a status line from a server says, for styling (a browser source reports its own state, so this is only for text that has none). */
export function stateOfStatus(status: string): NonNullable<VenueEntry['state']> {
  if (/crossed|left off|stale|error|unavailable|failed|refused|down\b/i.test(status)) return 'error';
  if (/connecting|reconnecting|starting|subscribing|gap/i.test(status)) return 'connecting';
  if (/^(live|ok)\b/i.test(status)) return 'live';
  return 'off';
}

/** A chosen venue the page is not drawing, and why. */
export interface IdleVenue { id: string; name: string; kind: 'connecting' | 'faulty'; status: string }

/**
 * The venues a person chose that have no book on the map: still connecting, failed, or (on a server) left off the map because the
 * book is faulty. Without a chip of their own they just vanish from the toolbar, and nothing says why. Venues that refuse this location
 * have their own chips and banner, so they are not repeated here.
 */
export function idleVenues(venues: readonly VenueEntry[], drawn: ReadonlySet<string>): IdleVenue[] {
  const out: IdleVenue[] = [];
  for (const v of venues) {
    if (!v.selected || !v.supported || drawn.has(v.id) || v.state === 'blocked') continue;
    const state = v.state ?? stateOfStatus(v.status);
    if (state === 'off' || state === 'upcoming') continue;
    out.push({ id: v.id, name: v.name, kind: state === 'error' ? 'faulty' : 'connecting', status: v.status });
  }
  return out;
}

/** The sentence a chip for an idle venue says on hover. */
export function idleText(v: IdleVenue): string {
  if (/crossed/i.test(v.status)) return `${v.name}: ${v.status}. A crossed book is a fault in the exchange feed, so it stays off the map until the book is consistent again.`;
  return v.kind === 'faulty' ? `${v.name}: ${v.status}. It is not on the map.` : `${v.name} is still connecting (${v.status}), so it is not on the map yet.`;
}

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
