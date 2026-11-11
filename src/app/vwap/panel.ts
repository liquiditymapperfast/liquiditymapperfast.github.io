import type { Store } from '../store.ts';
import { el } from '../dom.ts';
import { heading, note, selectRow, switchRow } from '../ui.ts';
import { helpButton } from '../help.ts';
import { t, tn } from '../i18n.ts';
import { anchorDate, clock, clockYear, usd } from '../format.ts';
import { toast } from '../toast.ts';
import { PALETTES, resolveThemeId, type Palette } from '../theme.ts';
import { ruleCode, ruleKey, ruleName, type Anchor, type AnchorRule, type Resolved } from '../anchors/anchors.ts';
import { anchorWhen, dateField, forgetDraft, lineSwatch, lowContrast, periodZoneName, ruleGrid } from '../anchors/controls.ts';
import { anchorDefault, rollingDefault } from './colours.ts';
import { ANCHOR_REACH_MS } from './vwap.ts';
import { currentCoin, scaledUsd } from '../coin.ts';
import { WHALE_BANDS_USD } from '../../shared/print-sums.ts';
import { venueLabel } from '../venues.ts';
import { venueMark } from '../venue-marks.ts';
import { parsePick } from '../market-choice.ts';
import { historyTarget, type HistoryTarget } from '../keylevels/history.ts';
import { MAX_ANCHORS, ROLLING_DAYS, VWAP_STARTS, anchorsOf, changeAnchor, hasOwnColors, putBackAnchor, restoreAnchor, withAnchor, withRolling, withThemeColors, withoutAnchor, type VwapColors, type VwapSettings } from './settings.ts';
import { MAX_VWAP_MARKETS, VWAP_PICKS, pickTarget, quoteOf, seedPicks, vwapTargets, type VwapMarketState } from './markets.ts';
import { vwapCode } from './paint.ts';
import type { RollingState } from './vwap.ts';

/** What the page knows of the whale sums: where the recording's count of large orders begins, whether the source has them, which source it is. */
export interface WhaleInfo { since: number | null; state: 'ready' | 'unavailable'; browser: boolean }
/** The map's `rollingReach`: each window's `RollingState`. */
export type RollingReach = (days: number) => RollingState;
/** The map's `vwapMarketStates`: the markets the lines read and how each stands. */
export type VwapMarkets = () => VwapMarketState[];
/** The map's `ruleStart`: where a live anchor's rule lands now. */
export type RuleStart = (rule: AnchorRule) => Resolved;
/** The map's `anchorDrawnFrom`: where an anchor's line is drawn from (later than the anchor where no finer candles reach it), null if not drawn. */
export type DrawnFrom = (id: string, at: number) => number | null;

/** A market as the panel names it: its exchange and its own name for the coin (Binance BTCUSDT, Coinbase BTC-USD). */
const marketName = (target: HistoryTarget): string => `${venueLabel(target.id)} ${target.listing.symbol}`;

/**
 * The VWAP panel, in the order a person decides (Sol, 2026-11-10): whether the lines show; whose candles they add up (the chart's market, or
 * markets ticked here, each exchange's spot and perpetual apart, and what each of them can give); the session VWAP (what it starts again at,
 * its bands); the rolling ones (each with a remove button, those not shown to add, and which have no line because the history is shorter
 * than their window); the anchored ones (each with its start and a remove button, and a button that arms the next click on the map to place
 * one); the whale VWAP (its size, and since when the large orders are recorded); labels and axis tags.
 */
export function buildVwapPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, whale: () => WhaleInfo | null = () => null, rollingReach: RollingReach = () => 'coming', markets: VwapMarkets = () => [], ruleStart: RuleStart = () => ({ state: 'coming' }), drawnFrom: DrawnFrom = () => null): void {
  const s = store.state.vwap, coin = currentCoin().coin, p = PALETTES[resolveThemeId(store.state.theme)] ?? PALETTES.dark!;
  const set = (change: Partial<VwapSettings>, again = false): void => { store.set({ vwap: { ...store.state.vwap, ...change } }); if (again) rebuild(); };
  const setColors = (change: (c: VwapColors) => VwapColors): void => store.set({ vwap: { ...store.state.vwap, colors: change(store.state.vwap.colors) } });
  tools.append(helpButton('vwap'));
  body.append(switchRow(t('Show VWAP'), t('The average price the market traded at, weighted by volume, as lines across the map.'), s.on, on => set({ on }, true)));
  // The sections are a long scroll: a link to each (Sol, review 2026-11-11: "anchor at the yearly high" was four screens down).
  const jump = (section: string, label: string): HTMLButtonElement => el('button', { type: 'button', textContent: label, onclick: () => {
    const head = body.querySelector<HTMLElement>(`[data-section="${section}"]`); if (head) body.scrollTop = head.offsetTop - 8;
  } });
  body.append(el('nav', { class: 'panel-jump', ariaLabel: t('Sections') }, jump('session', t('Session')), jump('rolling', t('Rolling')), jump('anchored', t('Anchored')), jump('whale', t('Whale'))));
  candlesFrom(store, body, rebuild, markets);
  body.append(
    section(t('Session'), 'session'),
    switchRow(t('Session VWAP'), t('Starts again at each day, week or month, in the zone the Volume profile and Key levels use.'), s.session, session => set({ session })),
    selectRow(t('Starts again each'), t('The stretch the average is taken over.'), [['day', t('Day')], ['week', t('Week')], ['month', t('Month')]], s.period, v => set({ period: v === 'week' || v === 'month' ? v : 'day' }, true)),   // the start row is a day's only
    ...(s.period === 'day' ? [selectRow(t('Session starts at'), t('The time of day the day\'s average starts at, in the zone the Volume profile and Key levels use. Midnight keeps the calendar day.'), VWAP_STARTS, String(s.startMinute ?? ''), v => set({ startMinute: v === '' ? null : Number(v) }))] : []),
    selectRow(t('Bands'), t('Lines one and two standard deviations either side: how far prices spread around the average, weighted by volume.'), [['0', t('None')], ['1', '±1σ'], ['2', '±1σ ±2σ']], String(s.bands), v => set({ bands: v === '1' ? 1 : v === '2' ? 2 : 0 })),
    colorRow(t('Colour'), t('The session line and its bands.'), lineSwatch(s.colors.session ?? p.vwap, s.colors.session !== undefined, t('Session VWAP'),
      color => setColors(c => { const { session: _s, ...rest } = c; return color ? { ...rest, session: color } : rest; }), rebuild, 'vwap-session')),
    ...(s.colors.session && lowContrast(s.colors.session, p) ? [note(t('{line}: this colour is hard to see on this theme.', { line: t('Session VWAP') }))] : []),
    section(t('Rolling VWAP'), 'rolling'),
    note(t('The average over the last days up to each moment: as time moves on, the oldest trades drop out of it. It is the same at every timeframe.')),
  );
  for (const days of s.rolling) {
    const remove = el('button', { type: 'button', class: 'session-remove', ariaLabel: t('Remove'), tip: t('Remove this window'), onclick: () => { store.set({ vwap: withRolling(store.state.vwap, days, false) }); rebuild(); } });
    const own = s.colors.rolling[String(days)], code = vwapCode({ kind: 'rolling', n: days });
    const swatch = lineSwatch(own ?? rollingDefault(days, p), own !== undefined, code, color => setColors(c => {
      const { [String(days)]: _old, ...rest } = c.rolling; return { ...c, rolling: color ? { ...rest, [String(days)]: color } : rest };
    }), rebuild, `vwap-rolling-${days}`);
    remove.dataset.focus = `vwap-rolling-${days}-remove`;
    body.append(el('div', { class: 'session-row vwap-anchor' }, swatch.swatch, el('span', { class: 'name', textContent: code }), el('span', { class: 'desc', textContent: tn(days, '{n} day up to now', '{n} days up to now') }),
      el('span', { class: 'row-tools' }, ...(swatch.reset ? [swatch.reset] : []), remove)));
    if (own && lowContrast(own, p)) body.append(note(t('{line}: this colour is hard to see on this theme.', { line: code })));
  }
  const more = ROLLING_DAYS.filter(days => !s.rolling.includes(days));
  if (more.length) body.append(el('div', { class: 'session-add' }, el('span', { class: 'desc', textContent: t('Add:') }),
    // Adding a line is asking to see it: the VWAP is switched on with it.
    ...more.map(days => el('button', { type: 'button', textContent: `${days}D`, tip: tn(days, '{n} day up to now', '{n} days up to now'), onclick: () => { store.set({ vwap: { ...withRolling(store.state.vwap, days, true), on: true } }); rebuild(); } }))));
  if (s.on) for (const days of s.rolling) {
    const reach = rollingReach(days), line = vwapCode({ kind: 'rolling', n: days });
    if (reach === 'short') body.append(note(t('{line}: not enough history for this window, so no line.', { line })));
    else if (reach === 'failed') body.append(note(t('{line}: its candles could not be read just now; trying again in a minute.', { line })));
  }
  anchoredSection(store, body, rebuild, ruleStart, drawnFrom, p);
  body.append(
    section(t('Whale VWAP'), 'whale'),
    switchRow(t('Whale VWAP'), t('The average price the large market orders paid since the session began: buys in the buy colour, sells in the sell colour.'), s.whale, on => set({ whale: on }, true)),
    // Four sizes only: the whale sums are kept per size band in memory (shared/print-sums.ts), not per order.
    selectRow(t('Orders from'), t('Only market orders at least this large are averaged, on the exchanges switched on.'), WHALE_BANDS_USD.map(b => [String(b), `≥ $${usd(scaledUsd(b))}`] as [string, string]), String(s.whaleUsd), v => set({ whaleUsd: Number(v) })),
  );
  const info = whale();
  if (s.whale && info) {
    if (info.state === 'unavailable') body.append(note(info.browser ? t('The orders could not be read just now; trying again in a minute.') : t('This server does not keep whale sums yet: it needs restarting with the new version.')));
    else if (info.since !== null) body.append(note(t('Large orders are recorded since {time}: on a longer session the whale lines start there.', { time: clock(info.since, true) })));
    if (info.browser) body.append(note(t('This page reads the exchanges itself: it counts the orders it has recorded in this browser.')));
  }
  body.append(
    switchRow(t('Labels'), t('Each line\'s name and price at its right end, where there is room.'), s.labels, labels => set({ labels })),
    switchRow(t('Tags on the price axis'), t('The name of each line that reaches the right edge, beside its price.'), s.tags, tags => set({ tags })),
  );
  if (hasOwnColors(s, coin)) body.append(el('div', { class: 'session-add' }, el('button', { type: 'button', textContent: t('Reset colours'), tip: t('Every VWAP line back to the theme\'s colours.'),
    onclick: () => { store.set({ vwap: withThemeColors(store.state.vwap, coin) }); rebuild(); } })));
}

/** A row like the switch rows, its control a line's colour (`lineSwatch`): its name and what it colours on the left, the swatch on the right. */
function colorRow(name: string, description: string, swatch: { swatch: HTMLElement; reset: HTMLElement | null }): HTMLElement {
  return el('div', { class: 'field color-field' }, el('span', { class: 'label' }, el('span', { class: 'name', textContent: name }), el('span', { class: 'desc', textContent: description })),
    el('span', { class: 'swatch-pair' }, ...(swatch.reset ? [swatch.reset] : []), swatch.swatch));
}

/** A section's heading, which the jump links at the panel's top scroll to. */
function section(text: string, key: string): HTMLElement { const h = heading(text); h.dataset.section = key; return h; }

/** The anchor whose editor is open in the panel (its id), kept while the panel is built again. */
let editing: string | null = null;
/** Close an anchor's editor: it was moved on the chart (`main.ts` `placeAnchor`), as a move by date closes it. */
export const closeAnchorEditor = (id: string): void => { if (editing === id) editing = null; };

/**
 * The anchored VWAPs (Karl, 2026-11-11: "nobody wants to click the exact candle"; designed with Sol 6.1 and the advisor, reviewed by Sol): the
 * coin's anchors, each with its colour, its name (a live one's rule; a fixed one's date, as its line is named), where it starts now, show or
 * hide, Edit and remove (with Undo); then three ways to add one, the quickest first: a box in the grid of periods (it follows its rule,
 * moving to each new high or low, or on to the next period), a date and an optional time, or a candle clicked on the chart.
 */
function anchoredSection(store: Store, body: HTMLElement, rebuild: () => void, ruleStart: RuleStart, drawnFrom: DrawnFrom, p: Palette): void {
  const s = store.state.vwap, coin = currentCoin().coin, list = anchorsOf(s, coin, Date.now()), full = list.length >= MAX_ANCHORS;
  const fullWhy = full ? t('Six anchors already: remove one to add another (hidden ones count too).') : null;
  // Whatever commits an anchor ends placing one on the chart (Sol, review 2026-11-11: a move armed stayed armed after a date was typed).
  const stopPlacing = (): void => { if (store.state.vwapAnchoring) store.set({ vwapAnchoring: false, anchorMove: null, anchorPreview: null }); };
  const put = (next: VwapSettings, refused?: string): void => {
    if (next === store.state.vwap) { if (refused) toast(refused); return; }
    stopPlacing(); store.set({ vwap: { ...next, on: true } }); rebuild();
  };
  // A remove can be taken back: the anchor returns where it was, with its colour, unless six are there again or the same one is back.
  const remove = (a: Anchor, index: number, name: string): void => {
    if (store.state.anchorMove === a.id) stopPlacing();
    store.set({ vwap: withoutAnchor(store.state.vwap, coin, a.id) }); if (editing === a.id) editing = null; forgetDraft(`vwap-anchor-${a.id}`); rebuild();
    toast(t('{line} removed.', { line: name }), { ms: 8_000, action: { label: t('Undo'), run: () => {
      const back = restoreAnchor(store.state.vwap, coin, a, index);
      if (back === store.state.vwap) { toast(t('Not undone: six anchors are there again, or the same one is back.')); return; }
      store.set({ vwap: back }); rebuild();
    } } });
  };
  body.append(section(t('Anchored VWAP'), 'anchored'), note(t('The average from a moment up to now. Choose a period below, enter a date, or click a candle.')));
  list.forEach((a, index) => {
    const open = editing === a.id, key = `vwap-anchor-${a.id}`;
    // Its name: a live one's rule; a fixed one's line as the chart names it ("AVWAP Nov 9 07:00"), which tells fixed ones apart, also to a
    // screen reader (Sol, review round 2), its kind under it.
    const name = a.rule ? ruleName(a.rule) : `${t('AVWAP')} ${anchorDate(a.at!)}`;
    const swatch = lineSwatch(a.color ?? anchorDefault(a.slot, p), a.color !== undefined, name, color => store.set({ vwap: changeAnchor(store.state.vwap, coin, a.id, { color }) }), rebuild, key);
    // Where it starts: a live one's as its rule lands now (read again every two seconds while the panel is open: it moves with new highs);
    // and where its line is drawn from, when that is later (no finer candles reach the anchor on this market).
    const when = el('span', { class: 'desc anchor-when' }), later = el('span', { class: 'desc anchor-later' });
    const read = (): Resolved => a.rule ? ruleStart(a.rule) : { state: 'ready', at: a.at! };
    const listeners: ((r: Resolved) => void)[] = [];
    const say = (): void => {
      const r = read(), code = a.rule ? `${t('AVWAP')} ${ruleCode(a.rule)}` : `${t('AVWAP')} ${anchorDate(a.at!)}`;
      // A fixed one's chart name is its name already.
      when.textContent = a.rule ? `${code} · ${anchorWhen(r)}` : t('Fixed anchor');
      const drawn = a.hidden || r.state !== 'ready' ? null : drawnFrom(a.id, r.at);
      later.textContent = r.state === 'ready' && drawn !== null && drawn > r.at + 60_000 ? t('drawn from {time}: no finer candles reach the anchor on this market', { time: clockYear(drawn) }) : '';
      later.hidden = !later.textContent;
      for (const listen of listeners) listen(r);
    };
    const timer = window.setInterval(() => { if (!when.isConnected) window.clearInterval(timer); else say(); }, 2_000);
    // One name, its state in aria-pressed (pressed: hidden), so a screen reader does not hear "Show" and "pressed" at once (code review).
    const eye = el('button', { type: 'button', class: 'anchor-eye', ariaLabel: t('Hide {line}', { line: name }), tip: a.hidden ? t('Show this line') : t('Hide this line, keeping it') });
    eye.dataset.hidden = String(!!a.hidden); eye.dataset.focus = `${key}-eye`; eye.setAttribute('aria-pressed', String(!!a.hidden));
    eye.onclick = () => { store.set({ vwap: changeAnchor(store.state.vwap, coin, a.id, { hidden: !a.hidden }) }); rebuild(); };
    const edit = el('button', { type: 'button', class: 'anchor-edit', textContent: open ? t('Done') : t('Edit'), ariaLabel: open ? t('Done editing {line}', { line: name }) : t('Edit {line}', { line: name }),
      ariaExpanded: String(open), tip: a.rule ? t('Freeze it at its candle, or move it to a date or another candle') : t('Change its date, or click another candle'),
      onclick: () => { if (open) { if (store.state.anchorMove === a.id) stopPlacing(); forgetDraft(key); } editing = open ? null : a.id; rebuild(); } });
    edit.dataset.focus = `${key}-edit`;
    const x = el('button', { type: 'button', class: 'session-remove', ariaLabel: t('Remove {line}', { line: name }), tip: t('Remove this anchor'), onclick: () => remove(a, index, name) });
    x.dataset.focus = `${key}-remove`;
    body.append(el('div', { class: `anchor-row${a.hidden ? ' hidden-one' : ''}` }, swatch.swatch,
      el('span', { class: 'anchor-what' }, el('span', { class: 'name', textContent: name }), when, later), ...(swatch.reset ? [swatch.reset] : []), eye, edit, x));
    if (a.color && lowContrast(a.color, p)) body.append(note(t('{line}: this colour is hard to see on this theme.', { line: name })));
    if (open) body.append(anchorEditor(store, rebuild, a, name, read, listeners, stopPlacing));
    say();
  });
  if (!list.length) body.append(note(t('No anchors yet for this coin.')));
  else if (full) body.append(note(fullWhy!));
  // The grid: one click puts an anchor on a period's start, high or low, and another click takes it off.
  body.append(el('p', { class: 'anchor-sub', textContent: t('Follow a period') }), ruleGrid({
    name: 'vwap-anchor', full: fullWhy,
    chosen: rule => { const a = list.find(x => x.rule && ruleKey(x.rule) === ruleKey(rule)); return a ? { color: a.color ?? anchorDefault(a.slot, p) } : null; },
    toggle: (rule, on) => {
      if (on) { put(withAnchor(store.state.vwap, coin, { rule }, Date.now())); return; }
      const now = anchorsOf(store.state.vwap, coin, Date.now()), index = now.findIndex(x => x.rule && ruleKey(x.rule) === ruleKey(rule));
      if (index >= 0) remove(now[index]!, index, ruleName(rule));
    },
  }));
  body.append(note(t('A high or low so far moves to each new one as it prints; a previous one changes when a new period begins. Periods follow {zone} time, as the Key levels do.', { zone: periodZoneName(store.state.traded.zone, store.state.timeZone) })));
  // A date: where the line would start is said before it is added.
  body.append(el('p', { class: 'anchor-sub', textContent: t('From a date') }), dateField({
    focus: 'vwap-anchor-new', action: t('Add'), actionLabel: t('Add an anchored VWAP from this date'), reachMs: ANCHOR_REACH_MS, tooOld: t('Too far back: an anchor reaches ten years.'), full: fullWhy,
    add: at => put(withAnchor(store.state.vwap, coin, { at }, Date.now()), t('An anchor starts at that minute already.')),
  }));
  // A candle on the chart: armed, the next click there places it (a drag still pans; Esc stops).
  const armed = store.state.vwapAnchoring && store.state.anchorMove === null;
  const place = el('button', { type: 'button', textContent: armed ? t('Cancel') : t('Click a candle'), disabled: full && !armed, tip: fullWhy ?? t('Then click the candle on the map where the average should start.'),
    onclick: () => { store.set(armed ? { vwapAnchoring: false } : { vwapAnchoring: true, anchorMove: null, rangeTool: false }); rebuild(); } });
  place.dataset.focus = 'vwap-anchor-place'; place.dataset.placing = 'true';
  body.append(el('p', { class: 'anchor-sub', textContent: t('From a candle') }), el('div', { class: 'session-add' }, place));
  if (armed) body.append(note(t('Click the candle on the map where the average should start; the arrow keys and Enter work too. Esc cancels.')));
}

/**
 * An anchor's editor, under its row: a live one is frozen at the candle its rule lands on now (the time on the button is the one kept, kept
 * up to date as the rule moves), moved to a date, or moved to a candle clicked; a fixed one is moved to a date or a candle. Moved or frozen,
 * it stays fixed there from then on, and Undo puts it back as it was.
 */
function anchorEditor(store: Store, rebuild: () => void, a: Anchor, name: string, read: () => Resolved, listeners: ((r: Resolved) => void)[], stopPlacing: () => void): HTMLElement {
  const coin = currentCoin().coin, key = `vwap-anchor-${a.id}`, box = el('div', { class: 'anchor-editor' });
  const moving = store.state.vwapAnchoring && store.state.anchorMove === a.id;
  const pick = el('button', { type: 'button', textContent: moving ? t('Cancel') : t('Click a candle'), ariaLabel: moving ? t('Cancel') : t('Move {line} to a candle you click', { line: name }), tip: t('Then click the candle on the map to move it there.'),
    onclick: () => { store.set(moving ? { vwapAnchoring: false, anchorMove: null } : { vwapAnchoring: true, anchorMove: a.id, rangeTool: false }); rebuild(); } });
  pick.dataset.focus = `${key}-pick`; pick.dataset.placing = 'true';
  // Moved or frozen: the anchor as it was can be put back (only while nobody has changed it since).
  const moved = (next: VwapSettings, what: string): void => {
    if (next === store.state.vwap) { toast(t('An anchor starts at that minute already.')); return; }
    stopPlacing(); store.set({ vwap: next }); editing = null; forgetDraft(key); rebuild();
    const now = next.anchors[coin]?.find(x => x.id === a.id);
    toast(what, { ms: 8_000, action: { label: t('Undo'), run: () => {
      const back = now ? putBackAnchor(store.state.vwap, coin, now, a) : store.state.vwap;
      if (back === store.state.vwap) { toast(t('Not undone: the anchor has changed since.')); return; }
      store.set({ vwap: back }); rebuild();
    } } });
  };
  const date = dateField({ focus: key, context: a.rule ? ruleKey(a.rule) : '', action: t('Move'), actionLabel: t('Move {line} to this date', { line: name }), value: a.at ?? null, reachMs: ANCHOR_REACH_MS, tooOld: t('Too far back: an anchor reaches ten years.'),
    add: at => moved(changeAnchor(store.state.vwap, coin, a.id, { at }), t('{line} moved to {time}.', { line: name, time: clockYear(at) })) });
  if (a.rule) {
    // The button says the time it keeps, and keeps the time it says.
    let shown: number | null = null;
    const freeze = el('button', { type: 'button', class: 'anchor-freeze', tip: t('Keep it at this candle: it stops following the period.'),
      onclick: () => { if (shown !== null) moved(changeAnchor(store.state.vwap, coin, a.id, { at: shown }), t('{line} frozen at {time}.', { line: name, time: clockYear(shown) })); } });
    freeze.dataset.focus = `${key}-freeze`;
    const show = (r: Resolved): void => {
      shown = r.state === 'ready' ? r.at : null;
      freeze.textContent = shown !== null ? t('Freeze at {time}', { time: clockYear(shown) }) : t('Freeze');
      freeze.disabled = shown === null;
    };
    show(read()); listeners.push(show);
    box.append(el('div', { class: 'session-add' }, freeze, pick), el('p', { class: 'anchor-sub', textContent: t('Or move it to a date') }), date,
      note(t('Frozen or moved, it stops following the period.')));
  } else box.append(date, el('div', { class: 'session-add' }, pick));
  if (moving) box.append(note(t('Click the candle on the map to move {line} there. Esc cancels.', { line: name })));
  return box;
}

/**
 * Whose candles the session, rolling and anchored lines add up: the chart's market (the default: the market on the chart, or the one standing
 * in for it where its history cannot be read), or the markets ticked (each exchange's spot and perpetual apart, at most `MAX_VWAP_MARKETS`;
 * switched to them, the boxes start from the market the lines read, so nothing changes until one is ticked), and what each of them gives:
 * one that could not be read, has not been read for minutes, or does not reach back far enough is named. A choice this coin has no market
 * for stays in the list, greyed, so it can be seen and taken off.
 */
function candlesFrom(store: Store, body: HTMLElement, rebuild: () => void, markets: VwapMarkets): void {
  const s = store.state.vwap, coin = currentCoin(), chart = store.state.marketId;
  body.append(selectRow(t('Candles from'), t("Which markets' candles the session, rolling and anchored lines are worked out from."), [['chart', t('The chart market')], ['chosen', t('Chosen markets')]], s.source, v => {
    const source = v === 'chosen' ? 'chosen' : 'chart', now = store.state.vwap;
    store.set({ vwap: { ...now, source, picks: source === 'chosen' && !now.picks.length ? seedPicks(chart, coin) : now.picks } });
    rebuild();
  }));
  if (s.source === 'chart') {
    const target = historyTarget(chart, coin);
    if (!target) { body.append(note(t('No market of this coin has a history the page can read, so there is no VWAP.'))); return; }
    body.append(note(t('From the candles of {market}: each bar\'s typical price (high, low and close) weighted by its volume, a minute at a time for a day and coarser for longer.', { market: marketName(target) })));
    if (!target.own) body.append(note(t('The market on the chart has no history the page can read, so another market of the coin is used; its prices can differ a little.')));
  } else {
    body.append(note(t('The lines combine the candles of the markets ticked below, even ones switched off in Venues. More markets take longer to load; with none ticked there is no VWAP.')));
    body.append(heading(t('Markets')));
    const list = el('div', { class: 'market-picker' }), boxes: HTMLInputElement[] = [];
    const sync = (): void => { const full = store.state.vwap.picks.length >= MAX_VWAP_MARKETS; for (const box of boxes) box.disabled = full && !box.checked; };
    // Every exchange and kind this coin is listed on, and a saved choice it is not, greyed.
    for (const pick of VWAP_PICKS.filter(p => pickTarget(p, coin, chart) || s.picks.includes(p))) {
      const parts = parsePick(pick)!, target = pickTarget(pick, coin, chart);
      const box = el('input', { type: 'checkbox', checked: s.picks.includes(pick) });
      box.onchange = () => {
        const kept = store.state.vwap.picks.filter(p => p !== pick);
        store.set({ vwap: { ...store.state.vwap, picks: box.checked ? [...kept, pick] : kept } });
        sync(); rebuild();
      };
      boxes.push(box);
      list.append(el('label', { class: `opt pick${target ? '' : ' missing'}`, tip: target?.id ?? '' }, box,
        el('span', { class: 'name' }, venueMark(target?.id ?? parts.family, 14), ` ${venueLabel(parts.family)} · ${parts.kind === 'spot' ? t('Spot') : t('Perpetual')}`),
        el('span', { class: 'desc', textContent: target ? target.listing.symbol : t('not listed for this coin here') })));
    }
    body.append(list);
    sync();
    if (s.picks.length >= MAX_VWAP_MARKETS) body.append(note(t('Up to six markets: untick one to choose another.')));
    const targets = vwapTargets('chosen', s.picks, chart, coin);
    if (new Set(targets.map(quoteOf)).size > 1) body.append(note(t('USD, USDT and USDC prices are treated as equal, with no currency conversion.')));
  }
  if (!store.state.vwap.on) return;
  for (const m of markets()) {
    const market = marketName(m.target);
    if (m.state === 'failed') body.append(note(t('{market}: its candles could not be read just now; trying again in a minute. The lines wait for it.', { market })));
    else if (m.state === 'stale') body.append(note(t('{market}: not updated since {time}; the lines stop there.', { market, time: clock(m.readTo, true) })));
    else if (m.state === 'short') body.append(note(t('{market}: its history reaches back to {date} only, so no line starts before it.', { market, date: clock(m.from, true) })));
  }
}
