import { el } from './dom.ts';
import { setTip } from './tip.ts';
import { clock, price as fmtPrice } from './format.ts';
import type { AppState } from './store.ts';
import type { SavingState, VenueEntry } from './source.ts';
import { t } from './i18n.ts';

/** A price older than this is called stale. */
export const STALE_PRICE_MS = 30_000;

/** How many of the chosen venues are live: `total` counts the selected ones, `live` those that are drawing. */
export function venueSummary(entries: readonly VenueEntry[]): { live: number; total: number; trouble: string[] } {
  const chosen = entries.filter(e => e.selected);
  return { live: chosen.filter(e => e.state === 'live').length, total: chosen.length, trouble: chosen.filter(e => e.state === 'error' || e.state === 'blocked').map(e => e.name) };
}

/** "3 s", "5 min", "2 h": how long ago, for a status line. */
export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? t('{n} s', { n: s }) : s < 5400 ? t('{n} min', { n: Math.round(s / 60) }) : t('{n} h', { n: Math.round(s / 3600) });
}

/** What becomes of the recordings, in words: `ok` is kept, `other` is kept by another tab of this page, `off` and `failed` are not kept. */
export interface SavingInfo { text: string; tip: string; state: 'ok' | 'other' | 'off' | 'failed' }

/** The words for what becomes of the recordings (nothing to say while it is not known yet). */
export function savingInfo(saving: SavingState): SavingInfo | null {
  switch (saving) {
    case 'server': return { text: t('Recorded by the server'), tip: t('The server records the heatmap, flow and footprint while it runs, whether or not this page is open.'), state: 'ok' };
    case 'here': return { text: t('Saving in this tab'), tip: t('Flow, footprint and large trades are saved in this browser, so they are still here after a reload or a restart.'), state: 'ok' };
    case 'other': return { text: t('Saved by another tab'), tip: t('Another tab of this page is saving the recordings; this tab reads what it saves.'), state: 'other' };
    case 'memory': return { text: t('Not saved'), tip: t('This session keeps its recordings in memory only (saving is off, or this browser does not allow it): they are gone when the page closes.'), state: 'off' };
    case 'failed': return { text: t('Saving stopped'), tip: t('The browser stopped storing the recordings (its storage may be full or refused): until the page is reloaded they are kept in memory only.'), state: 'failed' };
    case 'starting': return null;
  }
}

export interface StatusInfo {
  connection: { text: string; state: 'live' | 'down' };
  venues: { text: string; tip: string; state: 'ok' | 'some' | 'none' } | null;
  mark: { text: string; stale: boolean; tip: string } | null;
  recording: string | null;
  saving: SavingInfo | null;
  source: string;
}

/** Everything the status bar says, from what the page knows: pure, so the words are tested. */
export function statusInfo(state: Pick<AppState, 'status' | 'connected' | 'mark' | 'marketId'>, entries: readonly VenueEntry[], recordedSince: number, kind: 'server' | 'browser', now: number, saving: SavingState = 'starting'): StatusInfo {
  const v = venueSummary(entries);
  const mark = state.mark.price > 0 ? (() => { const old = state.mark.asOf > 0 ? now - state.mark.asOf : 0; return { text: `${fmtPrice(state.mark.price)}${old > 5_000 ? ` · ${age(old)}` : ''}`, stale: old > STALE_PRICE_MS, tip: old > STALE_PRICE_MS ? t('The price has not changed for {age}: the feed behind it may be down.', { age: age(old) }) : t('The latest price of the market on screen.') }; })() : null;
  return {
    connection: { text: state.status, state: state.connected ? 'live' : 'down' },
    venues: v.total ? { text: t('{live} of {total} venues live', { live: v.live, total: v.total }), tip: v.trouble.length ? t('Not drawing: {names}', { names: v.trouble.join(', ') }) : t('The venues you chose that are drawing now.'), state: v.live === v.total ? 'ok' : v.live ? 'some' : 'none' } : null,
    mark,
    recording: recordedSince > 0 ? t('Recording since {time}', { time: clock(recordedSince, now - recordedSince > 86_400_000) }) : null,
    saving: savingInfo(saving),
    source: kind === 'server' ? t('Server') : t('This browser'),
  };
}

/**
 * The bar along the bottom of the desktop page: whether the data is flowing, how many venues are live, the price and how old it is,
 * since when the recordings go, and where the data comes from. On a phone the top bar's status dot says the first of these and the rest
 * live in Settings, so this bar is a desktop thing (the stylesheet hides it elsewhere).
 */
export class StatusBar {
  readonly root = el('footer', { class: 'statusbar' });
  /** Where the language and theme buttons go on a desktop screen. */
  readonly controls = el('span', { class: 'status-controls' });
  #connection = el('span', { class: 'status-item status-conn' });
  #venues = el('span', { class: 'status-item status-venues' });
  #mark = el('span', { class: 'status-item status-mark' });
  #recording = el('span', { class: 'status-item status-rec' });
  #saving = el('span', { class: 'status-item status-save' });
  #source = el('span', { class: 'status-item status-src' });
  #entries: readonly VenueEntry[] = [];
  #written = new Map<Element, string>();

  constructor(private kind: 'server' | 'browser') {
    this.root.append(this.#connection, this.#venues, this.#mark, this.#recording, this.#saving, this.#source, el('span', { class: 'spacer' }), this.controls);
  }

  setVenues(entries: readonly VenueEntry[]): void { this.#entries = entries; }

  update(state: Pick<AppState, 'status' | 'connected' | 'mark' | 'marketId'>, recordedSince: number, saving: SavingState, now: number = Date.now()): void {
    const info = statusInfo(state, this.#entries, recordedSince, this.kind, now, saving);
    this.#set(this.#connection, info.connection.text, info.connection.state, t('Connection to the data source: live when frames are arriving.'));
    this.#set(this.#venues, info.venues?.text ?? '', info.venues?.state ?? '', info.venues?.tip ?? '');
    this.#set(this.#mark, info.mark?.text ?? '', info.mark?.stale ? 'stale' : '', info.mark?.tip ?? '');
    this.#set(this.#recording, info.recording ?? '', '', t('The heatmap, flow and footprint are recorded while the page (or the server) is running.'));
    this.#set(this.#saving, info.saving?.text ?? '', info.saving?.state ?? '', info.saving?.tip ?? '');
    this.#set(this.#source, t('Data: {source}', { source: info.source }), '', this.kind === 'server' ? t('The page reads the local server and its recorded history.') : t('The page reads the exchanges itself, in a worker, and records in this browser.'));
  }

  /** Write a node only when what it says changed: this runs every second and on every status change. */
  #set(node: HTMLElement, text: string, state: string, tip: string): void {
    const key = `${text}|${state}|${tip}`;
    if (this.#written.get(node) === key) return;
    this.#written.set(node, key);
    node.textContent = text; node.hidden = text === ''; node.dataset.state = state;
    setTip(node, tip);
  }
}
