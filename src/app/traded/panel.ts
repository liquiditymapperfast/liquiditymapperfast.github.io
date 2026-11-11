import type { Store } from '../store.ts';
import { el } from '../dom.ts';
import { heading, note, numberRow, selectRow, switchRow } from '../ui.ts';
import { helpButton } from '../help.ts';
import { clock, clockYear, usd } from '../format.ts';
import { toast } from '../toast.ts';
import { ruleKey, ruleName, type Anchor } from '../anchors/anchors.ts';
import { anchorWhen, dateField, lineSwatch, periodZoneName, ruleGrid } from '../anchors/controls.ts';
import { t } from '../i18n.ts';
import { LINE_KINDS, MAX_SESSIONS, ROW_MULTIPLES, SESSION_PRESETS, SHARES, ZONES, chartKinds, linesSource, mostCount, newSessionId, profileAnchorOf, recordedCount, restoreProfileAnchor, withProfileAnchor, type KindSettings, type LineKind, type TradedColors, type TradedSettings } from './settings.ts';
import { ANCHOR_BAR_MS, ANCHOR_EVERY, PROFILE_ANCHOR_REACH_MS, type AnchorSnapshot, type ProfileAnchorStart } from './anchor.ts';
import type { SessionDef } from './sessions.ts';
import { candleBarMs } from './levels.ts';
import { profileTarget, type KeyLevelHistory } from '../keylevels/history.ts';
import { currentCoin } from '../coin.ts';
import { venueLabel } from '../venues.ts';
import { BROWSER_RETENTION_MS, RETENTION_MS } from '../../shared/recorder.ts';
import { MEASURES, measureDef } from '../measures/registry.ts';
import { emphasisApplies, splitStyles } from './emphasis.ts';
import { PALETTES, resolveThemeId } from '../theme.ts';
import { anyPlaced, isPlaced, lineMetric, onPriceAxis, placedOn, setPlaced } from './profiles.ts';
import { arrangeProfiles, type ProfileRoom } from './arrange.ts';
import { hiddenText, placementGrid, placementSketch } from './placement-panel.ts';

/**
 * What the panel says about where days, weeks and sessions come from (whether the page reads the exchanges itself, and the candles), and
 * the room the map had when it was last drawn, for what of the profiles has no room (null before it was drawn).
 */
export interface TradedSources {
  browser: boolean; candles: ((barMs: number) => KeyLevelHistory) | null; room?: () => ProfileRoom | null;
  /** The columns' anchored window as the map holds it, and taking it again now (heat-pane.ts `anchoredWindow`, `updateAnchored`). */
  anchored?: () => AnchorSnapshot | null; updateNow?: () => void;
  /** Where the coin's anchor starts now (heat-pane.ts `profileAnchorStart`), and the bar an anchor at a moment is worked out on (`profileAnchorBar`). */
  anchorStart?: (a: Anchor) => ProfileAnchorStart; anchorBar?: (at: number) => number;
}

/**
 * The Volume profile panel: its first row switches everything below on and off, keeping every choice; then what the profiles look like,
 * their bars and their value area, the same wherever they are; where each measure is drawn (right or left of the map by price, along the
 * top by time), with the price rows their levels are read from and what each measure drawn says of itself; the periods drawn on the chart,
 * each day, week, month or session over its own time, as a grid of their lines and their bar profiles, with the sessions edited under it
 * and what the periods are worked out from; and what the lines draw. `gridStep` is the map's grid step now, for the row sizes in dollars.
 */
export function buildTradedPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, gridStep: () => number, sources: TradedSources = { browser: false, candles: null }): void {
  const s = store.state.traded, kinds = chartKinds(s);
  // The kind whose words the zone row uses: the shortest drawn (a day's words say the week's too).
  const zoned = (['day', 'week', 'month'] as const).find(k => kinds.includes(k));
  const set = (change: Partial<TradedSettings>, again = false): void => { store.set({ traded: { ...store.state.traded, ...change } }); if (again) rebuild(); };
  tools.append(helpButton('traded'));
  const grid = gridStep(), money = (v: number): string => `$${v >= 1 ? usd(v) : v.toPrecision(2)}`;
  const off = !store.state.show.traded;
  // Where each measure is drawn: what fits in the map's room as it was last drawn (nothing is reported before it was).
  const places = s.placements, room = sources.room?.() ?? null, arranged = room ? arrangeProfiles(places, room) : null;
  const sides = MEASURES.some(m => onPriceAxis(places, m.id)), tops = placedOn(places, 'top').length > 0, lines = lineMetric(places);
  // The places' heading is where a click on a band's header, or on a tag of what has no room, opens the panel (Toolbar.openTradedPanel).
  const placeHead = heading(t('Where each measure is drawn')); placeHead.dataset.section = 'placement';
  body.append(
    switchRow(t('Show the volume profile'), t('The profiles beside the map and along the top of the chart, and the point-of-control lines on the chart.'), store.state.show.traded, on => { store.set({ show: { ...store.state.show, traded: on } }); rebuild(); }),
    // Every choice below is kept while the switch is off, and none of it shows: said rather than leave the rows looking live.
    ...(off ? [note(t('The volume profile is off: nothing set below shows until it is switched on.'))] : []),
    ...(!off && room?.sides === 0 ? [note(t('A phone has no room for the columns: it draws the first band along the top, and the lines on the chart.'))] : []),
    // What the profile itself looks like, first: the bars, the value area and its share are the same for the columns and the time profile.
    selectRow(t('Bars'), t('Each row and each stretch as its two sides, or only their difference: which side was the bigger, and by how much.'), [['split', t('Buys and sells')], ['delta', t('Delta')]], s.bars, v => set({ bars: v === 'delta' ? 'delta' : 'split' }, true)),
    ...(s.bars === 'delta' ? [note(t('With Delta, each row and each stretch is drawn faintly at its whole size and the difference of its two sides over it, on the same scale: a busy row whose sides were close still shows. The point of control and the value area are read from the whole.'))] : []),
    ...emphasisRows(store, set),
    switchRow(t('Mark the value area'), t('Shade the value area on the columns and along the top, and draw its point of control and its edges across them.'), s.valueArea, valueArea => set({ valueArea })),
    selectRow(t('Value area'), t('The share of the volume the value area holds around the point of control. 70% is the usual one.'), SHARES.map(v => [String(v), `${v}%`] as [string, string]), String(s.share), v => set({ share: Number(v) })),
    profileColors(store, rebuild),
    // Where each measure is drawn (Karl, 2026-10-20): any measure right of the map, left of it or along the top, in any number of places.
    placeHead,
    note(t('Tick where each measure goes: a column right or left of the map adds it up by price, a band along the top by time, each over what is on the chart in the look set above. A measure can be in several places at once, and the columns left of the map mirror those on the right, so both face the chart.')),
    el('div', { class: 'place-box' }, placementGrid(places, (metric, placement, on) => set({ placements: setPlaced(store.state.traded.placements, metric, placement, on) }, true)), placementSketch(places, arranged)),
    ...(!sides && !tops ? [note(t('No profile is placed: only the lines on the chart show.'))] : []),
    // What has no room stays switched on and is said, here and on the map (a phone has no columns at all, said above).
    ...(!off && arranged && arranged.hidden.some(p => room!.sides > 0 || p.placement === 'top') ? [note(hiddenText(arranged.hidden.filter(p => room!.sides > 0 || p.placement === 'top')))] : []),
    ...(sides ? [note(t('The map keeps at least half the width, counting the columns on both sides: when they do not all fit, the ones nearest the map stay and the outermost wait for room.'))] : []),
    // What the columns add up (Karl, 2026-11-10): what is on the chart, or everything from an anchor up to now.
    ...(sides ? columnWindowRows(store, set, rebuild, sources) : []),
    ...(tops ? [note(t('Up to three bands stack along the top, each shorter the more there are and all of them a quarter of the chart\'s height at most; the first in the list is the lowest, nearest the chart.')),
      note(t('Each bar adds up a stretch of a round length, from a second to a day, about as thin as the column\'s rows at the zoom: zoom in for finer ones. Where the data is no finer (the flow before the last day, open interest), the caption says so. Point at a bar for its figures; click its header for these settings.'))] : []),
    // The level rows are dollars of price: they belong to the columns; time has its own interval, set by the zoom.
    selectRow(t('Row size'), t('The price rows the point of control is read from, at every price that traded: larger rows give a steadier level. Auto is the map\'s grid step.'),
      ROW_MULTIPLES.map(m => [String(m), m === 1 ? t('Auto ({value})', { value: money(grid) }) : money(grid * m)] as [string, string]), String(s.rows), v => set({ rows: Number(v) })),
    // What each measure drawn says of itself, by price where it has a column and by time where it has a band.
    ...MEASURES.filter(m => anyPlaced(places, m.id)).flatMap(m => [
      ...(onPriceAxis(places, m.id) ? m.priceNotes({ browser: sources.browser }).map(text => note(text)) : []),
      ...(isPlaced(places, m.id, 'top') ? [note(m.timeNote())] : []),
    ]),
    // A drag adds up traded volume at those prices, whatever the column shows: said only where traded volume has a column of its own.
    ...(MEASURES.some(m => m.rangeAddsUp && onPriceAxis(places, m.id)) ? [note(t('Drag on the column (or click a row) to add up those prices in the Range panel.'))] : []),
    // Which periods draw their lines (several) and which one kind draws its bar profiles, in one grid with a row a period (Karl, 2026-10-20):
    // drawn on the chart over their own time, never in the columns, which stay with what is on the chart (Karl, 2026-10-19).
    heading(t('Traded volume by period')),
    note(t('Choose Lines for reference levels—the point of control and value-area boundaries—and select any combination of periods. Choose Bar profiles to inspect volume by price inside each period; select one period type or None, independently of Lines.')),
    periodGrid(store, set),
    // The sessions are edited right under the grid that asks for them, not at the panel's foot where they read as something else.
    ...(kinds.includes('sessions') ? [sessionEditor(store, set)] : []),
  );
  if (kinds.length) {
    // The rows below speak for every kind drawn; where they differ, for the first that is not a month (a month is always from candles).
    const first: LineKind = kinds.find(k => k !== 'month') ?? 'month', k: KindSettings = { ...s, period: first };
    const target = profileTarget(currentCoin()), market = target ? `${venueLabel(target.id)} ${target.listing.symbol}` : '', source = linesSource(k);
    // What they are worked out from, the zone they start in and how many: one group under the grid, for every period drawn.
    if (first !== 'month') body.append(selectRow(t('Data source'), t('The recording: the trades of every venue the flow column counts, for as long as it keeps them. Candles: one market\'s, reaching back months, an estimate.'),
      [['recorded', t('The recording')], ['candles', target ? t('{market} candles', { market }) : t('Candles')]], s.source, v => set({ source: v === 'candles' ? 'candles' : 'recorded' }, true)));
    // The zone days, weeks and months start in is one for all of them (the Key levels' too): offered when any of them is drawn.
    if (zoned) body.append(selectRow(t('Period time zone'), zoned === 'month' ? t('The time zone whose midnight on the 1st starts a month.') : t('The time zone whose midnight starts a day, and whose Monday a week.'), ZONES.map(z => [z.zone, z.label] as [string, string]), s.zone, zone => set({ zone })));
    // From the recording, only as many as it still holds: a count it cannot work out is not offered.
    const most = source === 'candles' ? mostCount(k) : recordedCount(first, sources.browser ? BROWSER_RETENTION_MS : RETENTION_MS);
    if (most >= 1) body.append(numberRow(t('Periods shown, including current'), t('How many past ones are drawn, the one under way among them (of each session).'), { min: 1, max: most, step: 1, value: Math.min(s.count, most) }, count => set({ count: Math.max(1, Math.min(most, Math.round(count))) })));
    if (s.lines.length) body.append(switchRow(t('Extend untouched points of control'), t('A past point of control that price has not traded through since (a naked one) runs on, dotted, to where it was reached, or to the right edge.'), s.naked, naked => set({ naked })),
      switchRow(t('Carry the previous period\'s levels'), t('The previous day\'s, week\'s, month\'s or session\'s point of control and value area are drawn across the one under way, long-dashed and fainter, whether or not price has traded through them. The recording must still hold all of that period (usually it does not for a previous week on a server, which keeps a week of trades, nor for a previous day on a page, which keeps a day); candles reach further and are marked ≈.'), s.carry, carry => set({ carry })));
    // The recording holds a previous window of a kind only where it can hold two (a page a day, a server a week: no previous week), so with the
    // recording as the source and no kind that can, the switch carries nothing: said, not left looking live.
    const retention = sources.browser ? BROWSER_RETENTION_MS : RETENTION_MS;
    if (s.carry && s.lines.length && s.source === 'recorded' && !s.lines.some(k => k === 'month' || recordedCount(k, retention) >= 2)) {
      body.append(note(t('Nothing is carried from the recording for the periods ticked: it holds only the one under way (a server keeps a week of trades, a page a day). Work them out from candles to carry the previous one\'s levels.')));
    }
    if (source === 'recorded') {
      body.append(note(sources.browser
        ? t('This page keeps a day of trades, and only while it is open: it works out today and the last session at most, and no week. For older ones, work them out from candles.')
        : t('The recording keeps a week of trades: it works out the last seven days or sessions at most and the week under way. For older ones, work them out from candles.')));
    } else if (!target) {
      body.append(note(t('No market of this coin has candles the page can read.')));
    } else {
      // The candle size the lines use (five minutes, or one for a session off the five).
      const fine = candleBarMs(k) === 60_000;
      body.append(note(t('From the {minutes}-minute candles of {market}, with its spot market\'s where it has one, each one\'s volume spread evenly over its range and split by its taker buys: an estimate, marked ≈. On six recorded days, measured on the perpetual alone, the value area high and low mostly came within a row or two of the recording\'s (the low once 4 and once 10 rows off); where two prices traded almost the same, the point of control can sit on the other.', { minutes: fine ? 1 : 5, market })));
      if (sources.candles?.(fine ? 60_000 : 300_000).state === 'unavailable') body.append(note(t('Its history could not be read just now; trying again in a minute.')));
    }
    body.append(note(t('A day, week or session is drawn only when nine in ten of it is held: of the candles\' bars, or of the recording\'s trades, estimated from each venue\'s volume while it was recorded. Whether a point of control was traded through is read from the candles of the market on the chart.')));
  }
  // What each set of lines draws: the periods' chosen in the grid, or, with none chosen, the chart window's (the columns' own levels).
  body.append(
    heading(t('Line contents')),
    ...(!s.windowLines && !s.lines.length ? [note(t('No lines are ticked above: these settings draw nothing until one is.'))] : []),
    // Whose lines they are is said whenever it is not traded volume's, so moving or switching a column never changes their meaning unsaid.
    ...(lines !== 'volume' && s.windowLines ? [note(t('The chart window\'s lines use {measure}, the first measure drawn by price, since traded volume is not; period lines always use traded volume.', { measure: measureDef(lines).name() }))] : []),
    switchRow(t('Point of control'), t('The price that traded the most, as a line.'), s.poc, poc => set({ poc })),
    switchRow(t('Value area high and low'), t('The top and the bottom of the value area (VAH and VAL), as dashed lines.'), s.va, va => set({ va })),
    switchRow(t('Labels'), t('Each line\'s name and price at its right end, where there is room.'), s.labels, labels => set({ labels })),
    switchRow(t('Tags on the price axis'), t('The name of each line that reaches the right edge, beside its price.'), s.tags, tags => set({ tags })),
  );
}

/**
 * The switch that strengthens the bigger side of each split bar, and its key: three rows of one length, one even, one three to one, one
 * nearly all one side, drawn with the theme's own colours as the bars are (traded/emphasis.ts). With Delta bars it does nothing (they show
 * only the difference already), so it is greyed out with the reason, not hidden.
 */
function emphasisRows(store: Store, set: (change: Partial<TradedSettings>, again?: boolean) => void): HTMLElement[] {
  const s = store.state.traded, applies = emphasisApplies(s.bars), on = s.emphasis && applies;
  const row = switchRow(t('Emphasise the bigger side'), applies
    ? t('In each row and each stretch the bigger side is drawn stronger and the smaller one fainter, the more one-sided the more; thin rows stay even. It shows what happened, not what comes next.')
    : t('Delta bars draw only the difference of the two sides, which already says which was the bigger: this applies to split bars.'), s.emphasis, emphasis => set({ emphasis }, true));
  if (!applies) { row.querySelector('input')!.disabled = true; row.classList.add('off'); }
  const palette = PALETTES[resolveThemeId(store.state.theme)]!;
  const example = (b: number, label: string): HTMLElement => {
    const [first, second] = splitStyles(b, 100 - b, 0, 0, palette, on);
    const part = (share: number, style: { color: string; alpha: number }): HTMLElement => { const x = el('span'); x.style.width = `${share}%`; x.style.background = style.color; x.style.opacity = String(style.alpha); return x; };
    return el('div', { class: 'emphasis-row' }, el('span', { textContent: label }), el('span', { class: 'emphasis-bar' }, part(b, first), part(100 - b, second)));
  };
  return [row, el('div', { class: 'emphasis-key' }, example(50, '50 / 50'), example(55, '55 / 45'), example(60, '60 / 40'), example(70, '70 / 30'),
    el('p', { class: 'panel-note', textContent: t('Length: how much. Strength of colour: how one-sided.') }))];
}

/** What each period's row is called. */
const PERIOD_ROWS: Readonly<Record<LineKind, string>> = { day: t('Days'), week: t('Weeks'), month: t('Months'), sessions: t('Sessions') };

/**
 * The periods grid: the chart window's lines, then a row a period, its lines in the first column (boxes, any of them) and its bar profiles in
 * the second (round buttons, one kind or None, so profiles never lie over each other), the two independent. A month is longer than the recording keeps, so its row says it
 * comes from candles; the sessions' row names the sessions switched on.
 */
function periodGrid(store: Store, set: (change: Partial<TradedSettings>, again?: boolean) => void): HTMLElement {
  const s = store.state.traded, linesHead = t('Lines · several'), profilesHead = t('Bar profiles · one');
  const grid = el('div', { class: 'keylevel-grid period-grid', role: 'group', ariaLabel: t('Traded volume by period') },
    el('span', { class: 'head period-name', textContent: t('Period') }), el('span', { class: 'head', textContent: linesHead }), el('span', { class: 'head', textContent: profilesHead }));
  const profile = (kind: LineKind | null, name: string): HTMLElement => {
    const radio = el('input', { type: 'radio', name: 'traded-period-profiles', checked: s.profiles === kind, ariaLabel: `${name} · ${profilesHead}` });
    radio.dataset.focus = `period-profiles-${kind ?? 'none'}`;
    radio.onchange = () => { if (radio.checked) set({ profiles: kind }, true); };
    return el('label', { tip: `${name} · ${profilesHead}` }, radio);
  };
  // The chart window first: its point of control and value area, the columns' own levels, on or off on their own; its profile is the
  // columns, so it has no bar profiles of its own.
  const windowName = t('Chart window'), windowBox = el('input', { type: 'checkbox', checked: s.windowLines, ariaLabel: `${windowName} · ${linesHead}` });
  windowBox.dataset.focus = 'period-lines-window';
  windowBox.onchange = () => set({ windowLines: windowBox.checked }, true);
  grid.append(el('span', { class: 'what' }, el('span', { class: 'name', textContent: windowName }), el('span', { class: 'desc', textContent: t('Everything on the chart, as the columns add it up') })),
    el('label', { tip: `${windowName} · ${linesHead}` }, windowBox), el('span', { class: 'none', textContent: '—' }));
  for (const k of LINE_KINDS) {
    const name = PERIOD_ROWS[k], on = s.sessions.filter(x => x.on).map(x => x.name).join(', ');
    const desc = k === 'month' ? t('From candles, split by taker buys (≈)') : k === 'sessions' ? on : '';
    grid.append(el('span', { class: 'what', ...(k === 'month' ? { tip: t('A month is longer than the recording keeps: its lines come from candles, an estimate marked ≈.') } : {}) },
      el('span', { class: 'name', textContent: name }), ...(desc ? [el('span', { class: 'desc', textContent: desc })] : [])));
    const box = el('input', { type: 'checkbox', checked: s.lines.includes(k), ariaLabel: `${name} · ${linesHead}` });
    box.dataset.focus = `period-lines-${k}`;
    box.onchange = () => set({ lines: LINE_KINDS.filter(x => x === k ? box.checked : store.state.traded.lines.includes(x)) }, true);
    grid.append(el('label', { tip: `${name} · ${linesHead}` }, box), profile(k, name));
  }
  grid.append(el('span', { class: 'what' }, el('span', { class: 'name', textContent: t('None') })), el('span', { class: 'none', textContent: '—' }), profile(null, t('None')));
  return grid;
}

/** The session list: each one on or off, its name, start, end, zone and whether it skips weekends; add one from the usual ones, or remove it. */
function sessionEditor(store: Store, set: (change: Partial<TradedSettings>, again?: boolean) => void): HTMLElement {
  const sessions = store.state.traded.sessions;
  const update = (id: string, change: Partial<SessionDef>, again = false): void => set({ sessions: store.state.traded.sessions.map(x => x.id === id ? { ...x, ...change } : x) }, again);
  const rows = sessions.map(x => {
    const on = el('input', { type: 'checkbox', checked: x.on, ariaLabel: t('On') }); on.onchange = () => update(x.id, { on: on.checked }, true);
    const name = el('input', { type: 'text', value: x.name, maxLength: 40, ariaLabel: t('Name'), class: 'session-name' }); name.onchange = () => update(x.id, { name: name.value.trim().slice(0, 40) });
    const start = el('input', { type: 'time', value: x.start, ariaLabel: t('Starts'), class: 'session-time' }); start.onchange = () => { if (/^\d{2}:\d{2}$/.test(start.value)) update(x.id, { start: start.value }, true); };
    const end = el('input', { type: 'time', value: x.end, ariaLabel: t('Ends'), class: 'session-time' }); end.onchange = () => { if (/^\d{2}:\d{2}$/.test(end.value)) update(x.id, { end: end.value }, true); };
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

/**
 * What the columns by price add up: what is on the chart (the default), or everything from an anchor placed on the chart up to now, worked
 * out again every few minutes rather than with every trade, with Update now; when the anchored window was taken, and how far back each
 * measure can reach (each column says where its own numbers begin).
 */
function columnWindowRows(store: Store, set: (change: Partial<TradedSettings>, again?: boolean) => void, rebuild: () => void, sources: TradedSources): HTMLElement[] {
  const s = store.state.traded, coin = currentCoin().coin, out: HTMLElement[] = [];
  const stopPlacing = (): void => { if (store.state.profileAnchoring) store.set({ profileAnchoring: false, anchorPreview: null }); };
  out.push(selectRow(t('Columns cover'), t('The columns beside the map: what is on the chart, or everything from a candle you choose up to now.'), [['chart', t('What is on the chart')], ['anchor', t('From an anchor')]], s.columns, v => {
    if (v !== 'anchor') stopPlacing();
    set({ columns: v === 'anchor' ? 'anchor' : 'chart' }, true);
  }));
  if (s.columns !== 'anchor') return out;
  const a = profileAnchorOf(s, coin), armed = store.state.profileAnchoring;
  // Whatever sets the anchor ends placing it on the chart (Sol, review round 2: a click on the chart replaced the one just chosen).
  const put = (add: Parameters<typeof withProfileAnchor>[2]): void => { stopPlacing(); store.set({ traded: withProfileAnchor(store.state.traded, coin, add) }); rebuild(); };
  // The coin's anchor: what it follows (or that it is fixed), where it starts now, and remove (with Undo: the columns go back to the chart's).
  if (a) {
    const name = a.rule ? ruleName(a.rule) : t('Fixed anchor'), when = el('span', { class: 'desc anchor-when' });
    const say = (): void => { when.textContent = anchorWhen(sources.anchorStart?.(a) ?? { state: 'coming' }); };
    say();
    if (a.rule) { const timer = window.setInterval(() => { if (!when.isConnected) window.clearInterval(timer); else say(); }, 2_000); }
    const x = el('button', { type: 'button', class: 'session-remove', ariaLabel: t('Remove the anchor'), tip: t('Remove the anchor'), onclick: () => {
      stopPlacing(); store.set({ traded: withProfileAnchor(store.state.traded, coin, null) }); rebuild();
      // Undo puts it back only while no other anchor has been set since (Sol, review 2026-11-11: it replaced the new one).
      toast(t('Anchor removed: the columns add up what is on the chart.'), { ms: 8_000, action: { label: t('Undo'), run: () => {
        if (store.state.traded.anchors[coin]) { toast(t('Not undone: another anchor has been set since.')); return; }
        store.set({ traded: restoreProfileAnchor(store.state.traded, coin, a) }); rebuild();
      } } });
    } });
    x.dataset.focus = 'profile-anchor-remove';
    out.push(el('div', { class: 'anchor-row' }, el('span', { class: 'anchor-what' }, el('span', { class: 'name', textContent: name }), when), x));
  } else out.push(note(t('No anchor yet for this coin: the columns add up what is on the chart until one is set below.')));
  // One anchor a coin: a round button of the grid sets it to follow a period, a date or a candle fixes it.
  out.push(el('p', { class: 'anchor-sub', textContent: t('Follow a period') }), ruleGrid({
    name: 'profile-anchor', single: true,
    chosen: rule => a?.rule && ruleKey(a.rule) === ruleKey(rule) ? {} : null,
    toggle: (rule, on) => { if (on) put({ rule }); },
  }), note(t('Periods follow {zone} time, as the Key levels do.', { zone: periodZoneName(s.zone, store.state.timeZone) })));
  out.push(el('p', { class: 'anchor-sub', textContent: t('From a date') }), dateField({
    focus: 'profile-anchor', context: a ? `${a.id}|${a.rule ? ruleKey(a.rule) : ''}` : '', action: t('Set'), value: a?.at ?? null, reachMs: PROFILE_ANCHOR_REACH_MS, tooOld: t('Too far back: the columns reach two years.'),
    // Said back on the bar the window is worked out on: five minutes, or the hour (the zone's bar) for one older than 21 weeks.
    startOf: at => { const bar = sources.anchorBar?.(at) ?? ANCHOR_BAR_MS; return Math.floor(at / bar) * bar; }, add: at => put({ at }),
  }));
  const place = el('button', { type: 'button', textContent: armed ? t('Cancel') : t('Click a candle'), tip: t('Then click the candle on the map the columns should add up from.'),
    onclick: () => { store.set(armed ? { profileAnchoring: false } : { profileAnchoring: true, vwapAnchoring: false, rangeTool: false }); rebuild(); } });
  const again = el('button', { type: 'button', textContent: t('Update now'), disabled: !a, tip: t('Recalculate the anchored columns now, up to the last finished candle.'), onclick: () => { sources.updateNow?.(); } });
  place.dataset.focus = 'profile-anchor-place'; place.dataset.placing = 'true'; again.dataset.focus = 'profile-anchor-update';
  out.push(el('p', { class: 'anchor-sub', textContent: t('From a candle') }), el('div', { class: 'session-add' }, place, again));
  if (armed) out.push(note(t('Click the candle on the map the columns should add up from; the arrow keys and Enter work too. Esc cancels.')));
  out.push(selectRow(t('Update every'), t('How often the anchored columns are recalculated from the anchor. Less often means less work for the page.'),
    ANCHOR_EVERY.map(m => [String(m), m === 60 ? t('1 hour') : t('{n} min', { n: String(m) })] as [string, string]), String(s.every), v => set({ every: Number(v) })));
  const w = sources.anchored?.() ?? null;
  if (a && w && !w.state) out.push(note(w.to > w.from ? t('The columns show {from} to {to}, recalculated at {time}.', { from: clockYear(w.from), to: clock(w.to, true), time: clock(w.at) }) : t('The first five minutes after the anchor are not over yet.')));
  else if (a && w?.state === 'far') out.push(note(t('This anchor starts further back than the columns reach, so they are empty: choose a later one.')));
  out.push(note(t('Traded volume goes back two years, as an estimate from candles (≈): five-minute ones for the last 21 weeks, and before that the hourly ones (half- or quarter-hourly in a zone off the hour), so an older anchor starts on such a candle. Liquidations, absorption and open interest go back only as far as they were recorded.')));
  return out;
}

/**
 * The volume profile's colours (a user, 2026-11-10: colours for screenshots): the buys, the sells, and the point of control with the value
 * area, wherever it is drawn (the columns, the bands along the top, the profiles and lines on the chart); each the theme's until one is chosen,
 * with a way back to it.
 */
function profileColors(store: Store, rebuild: () => void): HTMLElement {
  const p = PALETTES[resolveThemeId(store.state.theme)] ?? PALETTES.dark!, c = store.state.traded.colors;
  const one = (key: keyof TradedColors, label: string, theme: string): HTMLElement => {
    const own = c[key], pick = lineSwatch(own ?? theme, own !== undefined, label, color => {
      const { [key]: _old, ...rest } = store.state.traded.colors;
      store.set({ traded: { ...store.state.traded, colors: color ? { ...rest, [key]: color } : rest } });
    }, rebuild, `profile-colour-${key}`);
    return el('span', { class: 'swatch-pair profile-color' }, el('span', { class: 'desc', textContent: label }), pick.swatch, ...(pick.reset ? [pick.reset] : []));
  };
  return el('div', { class: 'field color-field profile-colors' },
    el('span', { class: 'label' }, el('span', { class: 'name', textContent: t('Colours') }), el('span', { class: 'desc', textContent: t('The buys, the sells, and the point of control with the value area, wherever the profile is drawn.') })),
    el('span', { class: 'swatch-row' }, one('buy', t('Buys'), p.bid), one('sell', t('Sells'), p.ask), one('levels', t('Point of control and value area'), p.poc)));
}
