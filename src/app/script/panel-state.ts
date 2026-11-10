import { t, tn } from '../i18n.ts';
import type { Analysis } from './lang/analysis.ts';
import type { ScriptError } from './lang/lexer.ts';
import type { ScriptResult, Warning } from './protocol.ts';
import { cleanName, type OptionValue, type ScriptRecord } from './records.ts';
import type { ScriptBarsState } from './bars.ts';

/*
 * What the Scripts panel decides without drawing anything (so it can be tested without a page): what a script's row says, whether the
 * script being written has changes not saved, and where the panel opens again after it closed.
 */

/** What the panel needs of the pane that runs the scripts. */
export interface ScriptsHost {
  readonly records: readonly ScriptRecord[];
  setRecords(list: ScriptRecord[]): boolean;
  resultOf(id: string): ScriptResult | null;
  warningsOf(id: string): readonly Warning[];
  analysisOf(r: ScriptRecord): Analysis | ScriptError;
  /** Whether Scripts is on (the scripts run and draw); off, a script that is on waits for it. */
  readonly running: boolean;
  /** Switch Scripts on (a script was added or switched on: the person should see it). */
  showScripts(): void;
  /** The chart a script's last run worked on, as far as it is shown (for Copy for AI): its market, timeframe and candles; null without one. */
  ranOn(id: string): { market: string; timeframe: string; candles: number } | null;
  /** How many of the chart's candles scripts read (`script/bars.ts`), the choice of it, and how reading them stands. */
  readonly bars: number;
  setBars(bars: number): void;
  barsState(): ScriptBarsState;
}

/**
 * What the panel keeps while it is open: the script being written (a new one has the id `new`), its text so far, a message, which Delete waits
 * for its second press, and which description is open under its row (`list:` and a script's id, or `add:` and an example's key).
 */
export interface ScriptsPanelState {
  editing: string | null;
  draft: { name: string; source: string; options: Record<string, OptionValue>; place: ScriptRecord['place'] } | null;
  message: { text: string; error: boolean } | null;
  armed: string | null;
  about?: string | null;
}

/** What a script's row says: where it draws, then off, waiting for its first run, an error, its warnings or its plots. */
export function statusOf(host: ScriptsHost, r: ScriptRecord): { text: string; error: boolean } {
  const res = host.resultOf(r.id), notes = host.warningsOf(r.id).length + (res?.ok ? res.warnings.length : 0);
  const status = !r.on ? t('off') : !res ? (host.running ? t('running…') : t('not run yet')) : !res.ok ? t('error') : notes ? tn(notes, '{n} warning', '{n} warnings') : tn(res.plots.length, '{n} plot', '{n} plots');
  return { text: `${r.place === 'map' ? t('On the map') : t('In its own row')}${r.on && r.hidden ? ` · ${t('hidden')}` : ''} · ${status}`, error: r.on && !!res && !res.ok };
}

/** What `editing` holds for a script not kept yet: no script's id can be it (ids are lowercase letters, digits and dashes). */
export const NEW_SCRIPT = '+new';

/** A value written with the keys of its objects in order, so two option sets compare by what they hold, not by the order they were set in. */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => Object.is(x, -0) ? { '-0': true } // -0 is not 0 to a script (1 / x)
  : x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x);

/** Whether the script being written differs from what is kept (a new one: whether anything was written). */
export function unsaved(host: ScriptsHost, ui: ScriptsPanelState): boolean {
  const d = ui.draft; if (!d) return false;
  const r = host.records.find(x => x.id === ui.editing);
  if (!r) return d.source.trim() !== '' || d.name.trim() !== '';
  return (cleanName(d.name) ?? '') !== r.name || d.source !== r.source || d.place !== r.place || !sameOptions(d.options, r.options);
}

/** Whether two option sets hold the same values, whatever order they were set in. */
export const sameOptions = (a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean => stable(a) === stable(b);

/**
 * The panel closed: it opens on the list again next time, unless a script was being written and has changes not saved; that one opens again
 * where it was, saying so. Messages, a Delete waiting for its second press and an open description are let go.
 */
export function panelClosed(host: ScriptsHost, ui: ScriptsPanelState): void {
  ui.armed = null; ui.about = null;
  if (ui.editing && unsaved(host, ui)) { ui.message = { text: t('Not saved'), error: false }; return; }
  ui.editing = null; ui.draft = null; ui.message = null;
}
