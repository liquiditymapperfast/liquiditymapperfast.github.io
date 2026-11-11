import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { clockYear, timeZone, typedMoment, wallFields, zoneName } from '../format.ts';
import { contrastRatio, type Palette } from '../theme.ts';
import { ZONES, resolveZone } from '../traded/settings.ts';
import { ANCHOR_PERIODS, ANCHOR_POINTS, periodWord, ruleKey, ruleName, type AnchorPoint, type AnchorRule, type Resolved } from './anchors.ts';

/**
 * What the VWAP and Volume profile panels share to choose an anchor (Karl, 2026-11-11: "nobody wants to click the exact candle"; a user: "so i
 * can enter a date instead of clicking"): a grid of the periods' starts, highs and lows, one box each, as the Key levels choose theirs; a date
 * and an optional time, said back as where the anchor would start before it is added; the colour of a line, the theme's until one is
 * chosen; and how an anchor's start is said. Designed with Sol 6.1 and the advisor, reviewed by Sol (2026-11-11).
 */

/** Each row of the grid: its name, and what it means. */
const POINT_ROWS: Readonly<Record<AnchorPoint, { name: () => string; desc: () => string }>> = {
  start: { name: () => t('Start'), desc: () => t('Where the period began') },
  high: { name: () => t('High so far'), desc: () => t('Moves to each new high') },
  low: { name: () => t('Low so far'), desc: () => t('Moves to each new low') },
  prevHigh: { name: () => t('Previous high'), desc: () => t('The previous period\'s high') },
  prevLow: { name: () => t('Previous low'), desc: () => t('The previous period\'s low') },
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

/** The zone the rules' periods follow (the Volume profile's and Key levels' days), as the panels name it ("UTC", "New York", an IANA name). */
export function periodZoneName(tradedZone: string, pageZone: 'local' | 'utc'): string {
  const zone = resolveZone(tradedZone, pageZone);
  return ZONES.find(z => z.zone === zone)?.label ?? zone.replace(/_/g, ' ');
}

/** What is typed in a date field and not yet added, by the field's focus key: a panel built again (a refresh, a toggle) keeps it. */
const drafts = new Map<string, { date: string; time: string; base: string }>();
/** Forget a date field's draft (its editor closed, or its anchor moved). */
export const forgetDraft = (focus: string): void => { drafts.delete(focus); };

export interface DateFieldOptions {
  /** The button's word: Add (another VWAP anchor), Move (an anchor being changed), Set (the profile's one anchor). */
  action: string;
  /** The button's name for a screen reader, when the word alone says too little ("Move Week high so far to this date"). */
  actionLabel?: string;
  /** How far back an anchor can go, and what is said for a date further back. */
  reachMs: number; tooOld: string;
  /** Where an anchor at a moment typed starts (the profile's on the bar its window is worked out on), when not at that very minute. */
  startOf?: (at: number) => number;
  /** Put it there. */
  add: (at: number) => void;
  /** The fields as they open: an anchor's moment being changed; empty for a new one. */
  value?: number | null;
  /** Why it cannot be added, when it cannot (no room for another): the button is greyed and the line says it. */
  full?: string | null;
  /** The field's focus key: a panel built again keeps the keys there, and what was typed. */
  focus: string;
  /** What the anchor is now (its moment or its rule): a draft typed for another stands no longer (Sol, review round 2). */
  context?: string;
}

/**
 * A date and an optional time (midnight when left empty), on the chart's clock as its time axis reads, said back before it is added: where
 * the anchor would start, or why it cannot (a date that does not exist, a time a clock change skips, a time half typed, still to come,
 * further back than the anchor reaches). Enter in either field adds it, as the button.
 */
export function dateField(o: DateFieldOptions): HTMLElement {
  // A draft stands only while the anchor is where it was when it was typed: moved another way since (a candle clicked), the field shows where it is now.
  const now = Date.now(), base = `${o.context ?? ''}|${o.value ?? ''}|${timeZone()}`, kept = drafts.get(o.focus), draft = kept && kept.base === base ? kept : null, clockZone = zoneName(timeZone()).replace(/-/g, '‑');   // "GMT-3" never broken at its hyphen
  if (kept && !draft) drafts.delete(o.focus);
  const first = draft ?? (o.value != null ? wallFields(o.value) : null);
  const date = el('input', { type: 'date', value: first?.date ?? '', class: 'anchor-date', ariaLabel: t('Date'), min: wallFields(now - o.reachMs).date, max: wallFields(now).date });
  const time = el('input', { type: 'time', value: first?.time ?? '', step: '60', class: 'anchor-time', ariaLabel: t('Time (optional)'), tip: t('Leave it empty for midnight.') });
  date.dataset.focus = `${o.focus}-date`; time.dataset.focus = `${o.focus}-time`;
  const zone = el('span', { class: 'anchor-zone', textContent: clockZone, tip: t('The chart\'s clock, as its time axis reads (set in the page\'s settings).') });
  const go = el('button', { type: 'button', textContent: o.action, class: 'anchor-go', ...(o.actionLabel ? { ariaLabel: o.actionLabel } : {}) });
  go.dataset.focus = `${o.focus}-go`;
  const say = el('p', { class: 'panel-note anchor-say', ariaLive: 'polite' });
  say.id = `say-${o.focus}`; date.setAttribute('aria-describedby', say.id); time.setAttribute('aria-describedby', say.id);
  const check = (): number | null => {
    const at = Date.now();
    let start: number | null = null, why = '';
    if (!date.value) why = date.validity.badInput ? t('Finish the date, or clear it.') : t('Type or pick a date; the time is optional (midnight). On the chart\'s clock, {zone}.', { zone: clockZone });
    else if (time.validity.badInput) why = t('Finish the time, or clear it for midnight.');
    else {
      // Fields that still say the anchor's own moment keep that very instant (`typedMoment`: the hour a clock change repeats names two).
      const typed = typedMoment(o.value, date.value, time.value);
      if (typed === 'date') why = t('There is no such date.');
      else if (typed === 'time') why = t('The clocks skip that time on this day.');
      else {
        const s = o.startOf ? o.startOf(typed) : typed;
        if (s > at) why = t('That is still to come.');
        else if (s < at - o.reachMs) why = o.tooOld;
        else start = s;
      }
    }
    if (start !== null && o.full) why = o.full;
    say.textContent = start !== null && !o.full ? t('Starts {time} {zone}', { time: clockYear(start, at), zone: zoneName(timeZone(), start) }) : why;
    say.classList.toggle('warn', !!date.value && (start === null || !!o.full));
    go.disabled = start === null || !!o.full;
    return start;
  };
  date.oninput = time.oninput = () => { drafts.set(o.focus, { date: date.value, time: time.value, base }); check(); };
  go.onclick = () => { const start = check(); if (start !== null && !o.full) { drafts.delete(o.focus); o.add(start); } };
  date.onkeydown = time.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } };
  check();
  return el('div', { class: 'anchor-date-row' }, el('div', { class: 'anchor-date-fields' }, date, time, zone, go), say);
}

/**
 * A line's colour: a round swatch that opens the system's colour picker, the line repainting while it is dragged (no more than every 80 ms:
 * each change is saved), and, while the line has a colour of its own, a button back to the theme's (`reset`, null otherwise: a row puts it
 * among its buttons on the right, so the names stay in line). `set` gets the colour chosen, or null for the theme's; `done` runs when the
 * picker is closed (the panel is built again then, not while the picker is open, which would close it). `focus`: the swatch's focus key.
 */
export function lineSwatch(color: string, own: boolean, line: string, set: (color: string | null) => void, done: () => void, focus = ''): { swatch: HTMLInputElement; reset: HTMLButtonElement | null } {
  const input = el('input', { type: 'color', value: color, class: 'line-swatch', ariaLabel: t('Colour of {line}', { line }), tip: t('Colour of {line}', { line }) });
  if (focus) input.dataset.focus = `${focus}-colour`;
  let timer = 0, pending = '';
  input.oninput = () => { pending = input.value; if (!timer) timer = window.setTimeout(() => { timer = 0; set(pending); }, 80); };
  input.onchange = () => { window.clearTimeout(timer); timer = 0; set(input.value); done(); };
  const reset = own ? el('button', { type: 'button', class: 'line-swatch-reset', ariaLabel: t('Use the theme colour for {line}', { line }), tip: t('Use the theme colour'), onclick: () => { set(null); done(); } }) : null;
  if (reset && focus) reset.dataset.focus = `${focus}-reset`;
  return { swatch: input, reset };
}

/**
 * Whether a colour chosen for a line is hard to see on this theme (a yellow chosen on a dark one, kept on a light one): under 1.6:1 against
 * the background. The colour is kept as chosen; the panel says so (Sol, review 2026-11-11).
 */
export const lowContrast = (color: string, p: Pick<Palette, 'bg'>): boolean => contrastRatio(color, p.bg) < 1.6;

/**
 * Where an anchor starts now, as its row says it: from when (≈ where the exchange had no minutes inside the candle, so it is the candle's
 * start), or that it is being found, could not be read, is beyond the market's history, has no candle yet in its period, or (the profile's)
 * is further back than the columns reach.
 */
export function anchorWhen(r: Resolved | { state: 'far'; at: number }): string {
  switch (r.state) {
    case 'ready': return r.approx ? t('from ≈ {time} (no minute candles there)', { time: clockYear(r.at) }) : t('from {time}', { time: clockYear(r.at) });
    case 'far': return t('{time}: further back than the columns reach', { time: clockYear(r.at) });
    case 'coming': return t('finding it…');
    case 'failed': return t('its candles could not be read just now; trying again');
    case 'short': return t('only candles from {time} are available on this market', { time: clockYear(r.from) });
    case 'none': return t('no candles in this period');
  }
}
