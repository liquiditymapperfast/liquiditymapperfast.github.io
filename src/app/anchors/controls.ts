import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { clockYear, fromWallFields, timeZone, wallFields, zoneName } from '../format.ts';
import { ANCHOR_PERIODS, ANCHOR_POINTS, periodWord, ruleKey, ruleName, type AnchorPoint, type AnchorRule } from './anchors.ts';

/**
 * What the VWAP and Volume profile panels share to choose an anchor (Karl, 2026-11-11: "nobody wants to click the exact candle"; a user: "so i
 * can enter a date instead of clicking"): a grid of the periods' starts, highs and lows, one box each, as the Key levels choose theirs; a date
 * and an optional time, said back as where the anchor would start before it is added; and the colour of a line, the theme's until one is
 * chosen. Designed with Sol 6.1 and the advisor (2026-11-11).
 */

/** Each row of the grid: its name, and what it means. */
const POINT_ROWS: Readonly<Record<AnchorPoint, { name: () => string; desc: () => string }>> = {
  start: { name: () => t('Start'), desc: () => t('Where the period began') },
  high: { name: () => t('High so far'), desc: () => t('Moves to each new high') },
  low: { name: () => t('Low so far'), desc: () => t('Moves to each new low') },
  prevHigh: { name: () => t('Previous high'), desc: () => t('The last whole period\'s high') },
  prevLow: { name: () => t('Previous low'), desc: () => t('The last whole period\'s low') },
};

export interface RuleGridOptions {
  /** A name for the grid's buttons (their group, each one's focus key). */
  name: string;
  /** The anchor following a rule now, if any, and its line's colour (a box ticked in it: the grid is the lines' key too); null when none does. */
  chosen: (rule: AnchorRule) => { color?: string } | null;
  /** A box ticked (the rule's anchor added, or the one anchor set to it) or unticked (removed). */
  toggle: (rule: AnchorRule, on: boolean) => void;
  /** Why no more can be added, when none can: the boxes not ticked are greyed and say it. */
  full?: string | null;
  /** One rule at most (the profile's single anchor): round buttons, one of them on. */
  single?: boolean;
}

/**
 * The grid of rules, a column a period (day to year) and a row a point (its start, its high and low so far, the previous one's high and
 * low), as the Key levels panel lays out its lines: one click puts an anchor there, and it follows its rule from then on.
 */
export function ruleGrid(o: RuleGridOptions): HTMLElement {
  const grid = el('div', { class: 'keylevel-grid anchor-grid', role: 'group', ariaLabel: t('Anchor at') }, el('span'),
    ...ANCHOR_PERIODS.map(p => el('span', { class: 'head', textContent: periodWord(p) })));
  for (const point of ANCHOR_POINTS) {
    const row = POINT_ROWS[point];
    grid.append(el('span', { class: 'what', tip: row.desc() }, el('span', { class: 'name', textContent: row.name() }), el('span', { class: 'desc', textContent: row.desc() })));
    for (const period of ANCHOR_PERIODS) {
      const rule: AnchorRule = { period, point }, held = o.chosen(rule), name = ruleName(rule), greyed = held === null && !!o.full;
      const box = el('input', { type: o.single ? 'radio' : 'checkbox', checked: held !== null, disabled: greyed, ariaLabel: name });
      if (o.single) box.name = `${o.name}-rules`;
      box.dataset.focus = `${o.name}-${ruleKey(rule)}`;
      if (held?.color) box.style.accentColor = held.color;
      box.onchange = () => o.toggle(rule, box.checked);
      grid.append(el('label', { class: greyed ? 'greyed' : '', tip: greyed ? `${name} · ${o.full}` : name }, box));
    }
  }
  return grid;
}

export interface DateFieldOptions {
  /** The button's word: Add (another VWAP anchor), Move (a fixed one being changed), Set (the profile's one anchor). */
  action: string;
  /** How far back an anchor can go, and what is said for a date further back. */
  reachMs: number; tooOld: string;
  /** Where an anchor at a moment typed starts (the profile's on its five minutes), when not at that very minute. */
  startOf?: (at: number) => number;
  /** Put it there. */
  add: (at: number) => void;
  /** The fields as they open: a fixed anchor's moment being changed; empty for a new one. */
  value?: number | null;
  /** Why it cannot be added, when it cannot (no room for another): the button is greyed and the line says it. */
  full?: string | null;
  /** The field's focus key, so a panel built again keeps the keys there. */
  focus: string;
}

/**
 * A date and an optional time (midnight when left empty), on the chart's clock as its time axis reads, said back before it is added: where
 * the anchor would start, or why it cannot (a date that does not exist, still to come, further back than the anchor reaches). Enter in either
 * field adds it, as the button.
 */
export function dateField(o: DateFieldOptions): HTMLElement {
  const first = o.value != null ? wallFields(o.value) : null, now = Date.now();
  const date = el('input', { type: 'date', value: first?.date ?? '', class: 'anchor-date', ariaLabel: t('Date'), min: wallFields(now - o.reachMs).date, max: wallFields(now).date });
  const time = el('input', { type: 'time', value: first?.time ?? '', step: '60', class: 'anchor-time', ariaLabel: t('Time (optional)'), tip: t('Leave it empty for midnight.') });
  date.dataset.focus = `${o.focus}-date`; time.dataset.focus = `${o.focus}-time`;
  const zone = el('span', { class: 'anchor-zone', textContent: zoneName(timeZone()), tip: t('The chart\'s clock, as its time axis reads (set in the page\'s settings).') });
  const go = el('button', { type: 'button', textContent: o.action, class: 'anchor-go' });
  const say = el('p', { class: 'panel-note anchor-say', ariaLive: 'polite' });
  const check = (): number | null => {
    const typed = fromWallFields(date.value, time.value), at = Date.now();
    let start: number | null = null, why = '';
    if (!date.value) why = t('Type or pick a date; the time is optional.');
    else if (typed === null) why = t('There is no such date.');
    else {
      const s = o.startOf ? o.startOf(typed) : typed;
      if (s > at) why = t('That is still to come.');
      else if (s < at - o.reachMs) why = o.tooOld;
      else start = s;
    }
    if (start !== null && o.full) why = o.full;
    say.textContent = start !== null && !o.full ? t('Starts {time} {zone}', { time: clockYear(start, at), zone: zoneName(timeZone(), start) }) : why;
    say.classList.toggle('warn', !!date.value && (start === null || !!o.full));
    go.disabled = start === null || !!o.full;
    return start;
  };
  date.oninput = time.oninput = () => { check(); };
  go.onclick = () => { const start = check(); if (start !== null && !o.full) o.add(start); };
  date.onkeydown = time.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } };
  check();
  return el('div', { class: 'anchor-date-row' }, el('div', { class: 'anchor-date-fields' }, date, time, zone, go), say);
}

/**
 * A line's colour: a round swatch that opens the system's colour picker, the line repainting while it is dragged (no more than every 80 ms:
 * each change is saved), and, while the line has a colour of its own, a button back to the theme's (`reset`, null otherwise: a row puts it
 * among its buttons on the right, so the names stay in line). `set` gets the colour chosen, or null for the theme's; `done` runs when the
 * picker is closed (the panel is built again then, not while the picker is open, which would close it).
 */
export function lineSwatch(color: string, own: boolean, line: string, set: (color: string | null) => void, done: () => void): { swatch: HTMLInputElement; reset: HTMLButtonElement | null } {
  const input = el('input', { type: 'color', value: color, class: 'line-swatch', ariaLabel: t('Colour of {line}', { line }), tip: t('Colour of {line}', { line }) });
  let timer = 0, pending = '';
  input.oninput = () => { pending = input.value; if (!timer) timer = window.setTimeout(() => { timer = 0; set(pending); }, 80); };
  input.onchange = () => { window.clearTimeout(timer); timer = 0; set(input.value); done(); };
  const reset = own ? el('button', { type: 'button', class: 'line-swatch-reset', ariaLabel: t('Use the theme colour for {line}', { line }), tip: t('Use the theme colour'), onclick: () => { set(null); done(); } }) : null;
  return { swatch: input, reset };
}
