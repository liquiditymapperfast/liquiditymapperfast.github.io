import type { Store } from '../store.ts';
import { el } from '../dom.ts';
import { heading, note, numberRow, selectRow, switchRow } from '../ui.ts';
import { helpButton } from '../help.ts';
import { compactBar } from '../device.ts';
import { usd } from '../format.ts';
import { t } from '../i18n.ts';
import { MAX_COUNT, MAX_SESSIONS, ROW_MULTIPLES, SESSION_PRESETS, SHARES, ZONES, newSessionId, type TradedSettings } from './settings.ts';
import type { SessionDef } from './sessions.ts';

/**
 * The Volume profile panel: its first row switches the column (and with it the lines) on and off; then the column's bars and markers, how the point
 * of control and the value area are read, and the lines on the chart with what they are worked out over (what is on the chart, days, weeks
 * or sessions, which are edited here). `gridStep` is the map's grid step now, for the row sizes in dollars.
 */
export function buildTradedPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, gridStep: () => number): void {
  const s = store.state.traded;
  const set = (change: Partial<TradedSettings>, again = false): void => { store.set({ traded: { ...store.state.traded, ...change } }); if (again) rebuild(); };
  tools.append(helpButton('traded'));
  const grid = gridStep(), money = (v: number): string => `$${v >= 1 ? usd(v) : v.toPrecision(2)}`;
  body.append(
    switchRow(t('Show the volume profile'), t('The column of traded volume beside the book profile, and the point-of-control lines on the chart.'), store.state.show.traded, on => { store.set({ show: { ...store.state.show, traded: on } }); rebuild(); }),
    ...(compactBar() ? [note(t('A phone has no room for the column: the lines on the chart still show.'))] : []),
    heading(t('Column')),
    selectRow(t('Bars'), t('Buys and sells side by side, or only their difference: which side was the bigger at each price, and by how much.'), [['split', t('Buys and sells')], ['delta', t('Delta')]], s.bars, v => set({ bars: v === 'delta' ? 'delta' : 'split' })),
    switchRow(t('Mark the value area'), t('Shade the value area on the column and draw its point of control across it.'), s.valueArea, valueArea => set({ valueArea })),
    note(t('Drag on the column (or click a row) to add up those prices in the Range panel.')),
    heading(t('Point of control and value area')),
    selectRow(t('Value area'), t('The share of the volume the value area holds around the point of control. 70% is the usual one.'), SHARES.map(v => [String(v), `${v}%`] as [string, string]), String(s.share), v => set({ share: Number(v) })),
    selectRow(t('Row size'), t('The price rows the point of control is read from, at every price that traded: larger rows give a steadier level. Auto is the map\'s grid step.'),
      ROW_MULTIPLES.map(m => [String(m), m === 1 ? t('Auto ({value})', { value: money(grid) }) : money(grid * m)] as [string, string]), String(s.rows), v => set({ rows: Number(v) })),
    heading(t('Lines on the chart')),
    switchRow(t('Point of control'), t('The price that traded the most, as a line.'), s.poc, poc => set({ poc })),
    switchRow(t('Value area high and low'), t('The top and the bottom of the value area (VAH and VAL), as dashed lines.'), s.va, va => set({ va })),
    switchRow(t('Labels'), t('Name each line at its right end, the point of control with its price.'), s.labels, labels => set({ labels })),
    selectRow(t('Worked out over'), t('What is on the chart (the lines move with it), each day, each week, or the sessions below.'),
      [['view', t('What is on the chart')], ['day', t('Each day')], ['week', t('Each week')], ['sessions', t('Sessions')]], s.period, v => set({ period: v as TradedSettings['period'] }, true)),
  );
  if (s.period === 'day' || s.period === 'week') {
    body.append(selectRow(s.period === 'day' ? t('Days start in') : t('Weeks start in'), t('The time zone whose midnight starts a day, and whose Monday a week.'), ZONES.map(z => [z.zone, z.label] as [string, string]), s.zone, zone => set({ zone })));
  }
  if (s.period !== 'view') {
    body.append(
      numberRow(t('How many'), t('How many past ones are drawn, the one under way among them (of each session).'), { min: 1, max: MAX_COUNT, step: 1, value: s.count }, count => set({ count: Math.max(1, Math.min(MAX_COUNT, Math.round(count))) })),
      switchRow(t('Extend untouched points of control'), t('A past point of control that price has not traded through since (a naked one) runs on, dotted, to where it was reached, or to the right edge.'), s.naked, naked => set({ naked })),
    );
  }
  if (s.period === 'sessions') body.append(sessionEditor(store, set));
  if (s.period !== 'view') {
    body.append(note(t('A day, week or session recorded for less than nine in ten of its minutes is drawn faint. Whether a point of control was traded through is read from the candles of the market on the chart.')));
  }
}

/** The session list: each one on or off, its name, start, end, zone and whether it skips weekends; add one from the usual ones, or remove it. */
function sessionEditor(store: Store, set: (change: Partial<TradedSettings>, again?: boolean) => void): HTMLElement {
  const sessions = store.state.traded.sessions;
  const update = (id: string, change: Partial<SessionDef>, again = false): void => set({ sessions: store.state.traded.sessions.map(x => x.id === id ? { ...x, ...change } : x) }, again);
  const rows = sessions.map(x => {
    const on = el('input', { type: 'checkbox', checked: x.on, ariaLabel: t('On') }); on.onchange = () => update(x.id, { on: on.checked });
    const name = el('input', { type: 'text', value: x.name, maxLength: 40, ariaLabel: t('Name'), class: 'session-name' }); name.onchange = () => update(x.id, { name: name.value.trim().slice(0, 40) });
    const start = el('input', { type: 'time', value: x.start, ariaLabel: t('Starts'), class: 'session-time' }); start.onchange = () => { if (/^\d{2}:\d{2}$/.test(start.value)) update(x.id, { start: start.value }); };
    const end = el('input', { type: 'time', value: x.end, ariaLabel: t('Ends'), class: 'session-time' }); end.onchange = () => { if (/^\d{2}:\d{2}$/.test(end.value)) update(x.id, { end: end.value }); };
    const zone = el('select', { ariaLabel: t('Time zone'), class: 'session-zone' });
    for (const z of ZONES) if (z.zone !== 'page') zone.append(new Option(z.label, z.zone));
    if (![...zone.options].some(o => o.value === x.zone)) zone.append(new Option(x.zone, x.zone));
    zone.value = x.zone; zone.onchange = () => update(x.id, { zone: zone.value });
    const weekdays = el('input', { type: 'checkbox', checked: x.weekdays }); weekdays.onchange = () => update(x.id, { weekdays: weekdays.checked });
    const remove = el('button', { type: 'button', class: 'session-remove', ariaLabel: t('Remove'), tip: t('Remove this session'), onclick: () => set({ sessions: store.state.traded.sessions.filter(y => y.id !== x.id) }, true) });
    return el('div', { class: 'session-row' }, on, name, start, el('span', { class: 'session-dash', textContent: '–' }), end, zone,
      el('label', { class: 'session-weekdays', tip: t('Only Monday to Friday, in the session\'s zone.') }, weekdays, el('span', { textContent: t('Mon–Fri') })), remove);
  });
  const full = sessions.length >= MAX_SESSIONS;
  const add = (preset: Omit<SessionDef, 'id' | 'on'>): void => { const list = store.state.traded.sessions; if (list.length >= MAX_SESSIONS) return; set({ sessions: [...list, { ...preset, id: newSessionId(list), on: true }] }, true); };
  const adders = el('div', { class: 'session-add' }, el('span', { class: 'desc', textContent: t('Add:') }),
    ...SESSION_PRESETS.map(p => el('button', { type: 'button', textContent: p.name, disabled: full, tip: `${p.start}–${p.end}`, onclick: () => add(p) })),
    el('button', { type: 'button', textContent: t('Custom'), disabled: full, onclick: () => add({ name: t('Session'), zone: 'UTC', start: '00:00', end: '08:00', weekdays: false }) }));
  return el('div', { class: 'session-editor' },
    heading(t('Sessions')),
    ...(rows.length ? rows : [el('p', { class: 'panel-note', textContent: t('No sessions yet: add one below.') })]),
    adders,
    note(t('Times are the clock in the session\'s zone, so a session follows that zone\'s daylight saving. One that ends at or before its start runs past midnight; the same start and end is a whole day. Crypto trades every day, so every day has its sessions unless Mon–Fri is ticked.')));
}
