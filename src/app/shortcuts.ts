import { t } from './i18n.ts';
import type { AppState } from './store.ts';

/**
 * Keyboard shortcuts: one table, matched by one listener (main.ts). A key does nothing while typing in a field, while a dialog is open (the
 * coin picker, the screenshot editor) or with Ctrl, Alt or Meta held (so the browser's own shortcuts and AltGr characters pass through).
 * Digits are matched by their place on the keyboard (`code`), so 1 to 7 are the same keys on every layout; letters by what they type.
 */

/** The features a letter switches on or off, each one the switch of its lamp button. */
export type Feature = 'footprint' | 'trades' | 'liquidations' | 'absorption' | 'traded' | 'keyLevels' | 'vwap' | 'highlights';
export type ShortcutAction =
  | { kind: 'timeframe'; tf: string }
  | { kind: 'recenter' }
  | { kind: 'zoom'; dir: 1 | -1 }
  | { kind: 'toggle'; feature: Feature }
  | { kind: 'range' }
  | { kind: 'goto' }
  | { kind: 'screenshot' }
  | { kind: 'list' };

export type ShortcutGroup = 'timeframe' | 'chart' | 'show' | 'tools';
export interface Shortcut {
  group: ShortcutGroup;
  /** What the list shows on the key caps. */
  caps: readonly string[];
  /** What it does, in the list. */
  label: string;
  /** Matched by `KeyboardEvent.code` (a place on the keyboard) or by `key` (what the key types, lower case). */
  codes?: readonly string[];
  keys?: readonly string[];
  action: ShortcutAction;
  /** Whether holding the key repeats it (zoom); a switch flipping back and forth while held would not help anyone. */
  repeat?: boolean;
}

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const toggle = (cap: string, label: string, feature: Feature): Shortcut => ({ group: 'show', caps: [cap], label, keys: [cap.toLowerCase()], action: { kind: 'toggle', feature } });

export const SHORTCUTS: readonly Shortcut[] = [
  ...TIMEFRAMES.map((tf, i): Shortcut => ({ group: 'timeframe', caps: [String(i + 1)], label: tf, codes: [`Digit${i + 1}`, `Numpad${i + 1}`], action: { kind: 'timeframe', tf } })),
  { group: 'chart', caps: ['R', t('Home')], label: t('Recenter'), keys: ['r', 'home'], action: { kind: 'recenter' } },
  { group: 'chart', caps: ['+'], label: t('Zoom time in'), keys: ['+', '='], action: { kind: 'zoom', dir: 1 }, repeat: true },
  { group: 'chart', caps: ['−'], label: t('Zoom time out'), keys: ['-', '_'], action: { kind: 'zoom', dir: -1 }, repeat: true },
  toggle('F', t('Footprint'), 'footprint'),
  toggle('T', t('Trades'), 'trades'),
  toggle('L', t('Liquidations'), 'liquidations'),
  toggle('A', t('Absorption'), 'absorption'),
  toggle('P', t('Volume profile'), 'traded'),
  toggle('K', t('Key levels'), 'keyLevels'),
  toggle('V', t('VWAP'), 'vwap'),
  toggle('H', t('Highlights'), 'highlights'),
  { group: 'tools', caps: ['G'], label: t('Go to a date and time'), keys: ['g'], action: { kind: 'goto' } },
  { group: 'tools', caps: ['X'], label: t('Range: the next drag selects (Esc cancels)'), keys: ['x'], action: { kind: 'range' } },
  { group: 'tools', caps: ['S'], label: t('Screenshot'), keys: ['s'], action: { kind: 'screenshot' } },
  { group: 'tools', caps: ['?'], label: t('This list'), keys: ['?'], action: { kind: 'list' } },
];

/** What a key press carries that matters here (a KeyboardEvent, or a plain object in tests). */
export interface KeyPress { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat: boolean; target: unknown; defaultPrevented?: boolean }

/**
 * Whether the press belongs to something else: a field being typed in, an open dialog, a modifier (a browser shortcut, AltGr), or a handler
 * that already used it (a menu takes Home and End).
 */
export function ignored(e: KeyPress, dialogOpen: boolean): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen || e.defaultPrevented) return true;
  const target = e.target as { tagName?: unknown; isContentEditable?: unknown } | null;
  return !!target && (target.isContentEditable === true || (typeof target.tagName === 'string' && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)));
}

/** The shortcut a press means, or null. */
export function matchShortcut(e: KeyPress, dialogOpen: boolean, list: readonly Shortcut[] = SHORTCUTS): Shortcut | null {
  if (ignored(e, dialogOpen)) return null;
  const key = e.key.toLowerCase();
  const hit = list.find(s => s.codes?.includes(e.code) || s.keys?.includes(key)) ?? null;
  return hit && (!e.repeat || hit.repeat) ? hit : null;
}

/** The change to the state that switches `feature` the other way. */
export function togglePatch(state: AppState, feature: Feature): Partial<AppState> {
  switch (feature) {
    case 'footprint': return { show: { ...state.show, footprint: !state.show.footprint } };
    case 'trades': return { show: { ...state.show, bubbles: !state.show.bubbles } };
    case 'traded': return { show: { ...state.show, traded: !state.show.traded } };
    case 'liquidations': return { liquidations: { ...state.liquidations, on: !state.liquidations.on } };
    case 'absorption': return { absorption: { ...state.absorption, on: !state.absorption.on } };
    case 'keyLevels': return { keyLevels: { ...state.keyLevels, on: !state.keyLevels.on } };
    case 'vwap': return { vwap: { ...state.vwap, on: !state.vwap.on } };
    case 'highlights': return { highlight: { ...state.highlight, on: !state.highlight.on } };
  }
}

export const GROUP_TITLES: Readonly<Record<ShortcutGroup, string>> = { timeframe: t('Timeframe'), chart: t('Chart'), show: t('On or off'), tools: t('Tools') };
