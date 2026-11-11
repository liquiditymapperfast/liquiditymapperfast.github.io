import type { Store } from '../store.ts';
import { el } from '../dom.ts';
import { heading, note, selectRow, switchRow } from '../ui.ts';
import { helpButton } from '../help.ts';
import { t, tn } from '../i18n.ts';
import { clock, clockYear, usd } from '../format.ts';
import { toast } from '../toast.ts';
import { PALETTES, resolveThemeId, type Palette } from '../theme.ts';
import { ruleCode, ruleKey, ruleName, type Anchor, type AnchorRule, type Resolved } from '../anchors/anchors.ts';
import { dateField, lineSwatch, ruleGrid } from '../anchors/controls.ts';
import { anchorDefault, rollingDefault } from './colours.ts';
import { ANCHOR_REACH_MS } from './vwap.ts';
import { currentCoin, scaledUsd } from '../coin.ts';
import { WHALE_BANDS_USD } from '../../shared/print-sums.ts';
import { venueLabel } from '../venues.ts';
import { venueMark } from '../venue-marks.ts';
import { parsePick } from '../market-choice.ts';
import { historyTarget, type HistoryTarget } from '../keylevels/history.ts';
import { MAX_ANCHORS, ROLLING_DAYS, VWAP_STARTS, anchorsOf, changeAnchor, hasOwnColors, restoreAnchor, withAnchor, withRolling, withThemeColors, withoutAnchor, type VwapColors, type VwapSettings } from './settings.ts';
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

/** A market as the panel names it: its exchange and its own name for the coin (Binance BTCUSDT, Coinbase BTC-USD). */
const marketName = (target: HistoryTarget): string => `${venueLabel(target.id)} ${target.listing.symbol}`;

/**
 * The VWAP panel, in the order a person decides (Sol, 2026-11-10): whether the lines show; whose candles they add up (the chart's market, or
 * markets ticked here, each exchange's spot and perpetual apart, and what each of them can give); the session VWAP (what it starts again at,
 * its bands); the rolling ones (each with a remove button, those not shown to add, and which have no line because the history is shorter
 * than their window); the anchored ones (each with its start and a remove button, and a button that arms the next click on the map to place
 * one); the whale VWAP (its size, and since when the large orders are recorded); labels and axis tags.
 */
export function buildVwapPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, whale: () => WhaleInfo | null = () => null, rollingReach: RollingReach = () => 'coming', markets: VwapMarkets = () => [], ruleStart: RuleStart = () => ({ state: 'coming' })): void {
  const s = store.state.vwap, coin = currentCoin().coin, p = PALETTES[resolveThemeId(store.state.theme)] ?? PALETTES.dark!;
  const set = (change: Partial<VwapSettings>, again = false): void => { store.set({ vwap: { ...store.state.vwap, ...change } }); if (again) rebuild(); };
  const setColors = (change: (c: VwapColors) => VwapColors): void => store.set({ vwap: { ...store.state.vwap, colors: change(store.state.vwap.colors) } });
  tools.append(helpButton('vwap'));
  body.append(switchRow(t('Show VWAP'), t('The average price the market traded at, weighted by volume, as lines across the map.'), s.on, on => set({ on }, true)));
  candlesFrom(store, body, rebuild, markets);
  body.append(
    heading(t('Session')),
    switchRow(t('Session VWAP'), t('Starts again at each day, week or month, in the zone the Volume profile and Key levels use.'), s.session, session => set({ session })),
    selectRow(t('Starts again each'), t('The stretch the average is taken over.'), [['day', t('Day')], ['week', t('Week')], ['month', t('Month')]], s.period, v => set({ period: v === 'week' || v === 'month' ? v : 'day' }, true)),   // the start row is a day's only
    ...(s.period === 'day' ? [selectRow(t('Session starts at'), t('The time of day the day\'s average starts at, in the zone the Volume profile and Key levels use. Midnight keeps the calendar day.'), VWAP_STARTS, String(s.startMinute ?? ''), v => set({ startMinute: v === '' ? null : Number(v) }))] : []),
    selectRow(t('Bands'), t('Lines one and two standard deviations either side: how far prices spread around the average, weighted by volume.'), [['0', t('None')], ['1', '±1σ'], ['2', '±1σ ±2σ']], String(s.bands), v => set({ bands: v === '1' ? 1 : v === '2' ? 2 : 0 })),
    colorRow(t('Colour'), t('The session line and its bands.'), lineSwatch(s.colors.session ?? p.vwap, s.colors.session !== undefined, t('Session VWAP'),
      color => setColors(c => { const { session: _s, ...rest } = c; return color ? { ...rest, session: color } : rest; }), rebuild)),
    heading(t('Rolling VWAP')),
    note(t('The average over the last days up to each moment: as time moves on, the oldest trades drop out of it. It is the same at every timeframe.')),
  );
  for (const days of s.rolling) {
    const remove = el('button', { type: 'button', class: 'session-remove', ariaLabel: t('Remove'), tip: t('Remove this window'), onclick: () => { store.set({ vwap: withRolling(store.state.vwap, days, false) }); rebuild(); } });
    const own = s.colors.rolling[String(days)], code = vwapCode({ kind: 'rolling', n: days });
    const swatch = lineSwatch(own ?? rollingDefault(days, p), own !== undefined, code, color => setColors(c => {
      const { [String(days)]: _old, ...rest } = c.rolling; return { ...c, rolling: color ? { ...rest, [String(days)]: color } : rest };
    }), rebuild);
    body.append(el('div', { class: 'session-row vwap-anchor' }, swatch.swatch, el('span', { class: 'name', textContent: code }), el('span', { class: 'desc', textContent: tn(days, '{n} day up to now', '{n} days up to now') }),
      el('span', { class: 'row-tools' }, ...(swatch.reset ? [swatch.reset] : []), remove)));
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
  anchoredSection(store, body, rebuild, ruleStart, p);
  body.append(
    heading(t('Whale VWAP')),
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

/** The anchor whose editor is open in the panel (its id), kept while the panel is built again. */
let editing: string | null = null;

/**
 * The anchored VWAPs (Karl, 2026-11-11: "nobody wants to click the exact candle"; designed with Sol 6.1 and the advisor): the coin's anchors,
 * each with its colour, its name (a live one's rule, a fixed one's number), where it starts now, show or hide, Edit and remove (with Undo);
 * then three ways to add one, the quickest first: a box in the grid of periods (it follows its rule, moving to each new high or low, or on to
 * the next period), a date and an optional time, or a candle clicked on the chart.
 */
function anchoredSection(store: Store, body: HTMLElement, rebuild: () => void, ruleStart: RuleStart, p: Palette): void {
  const s = store.state.vwap, coin = currentCoin().coin, list = anchorsOf(s, coin, Date.now()), full = list.length >= MAX_ANCHORS;
  const fullWhy = full ? t('Up to six anchors: remove one to add another.') : null;
  const put = (next: VwapSettings, refused?: string): void => {
    if (next === store.state.vwap) { if (refused) toast(refused); return; }
    store.set({ vwap: { ...next, on: true } }); rebuild();
  };
  // A remove can be taken back: the anchor returns where it was, with its colour.
  const remove = (a: Anchor, index: number, name: string): void => {
    store.set({ vwap: withoutAnchor(store.state.vwap, coin, a.id) }); if (editing === a.id) editing = null; rebuild();
    toast(t('{line} removed.', { line: name }), { ms: 8_000, action: { label: t('Undo'), run: () => { store.set({ vwap: restoreAnchor(store.state.vwap, coin, a, index) }); rebuild(); } } });
  };
  body.append(heading(t('Anchored VWAP')),
    note(t('The average from a moment up to now. Tick a period\'s start, high or low below and the line follows it; or give a date; or click a candle.')));
  let fixed = 0;
  list.forEach((a, index) => {
    const n = a.rule ? 0 : ++fixed, name = a.rule ? ruleName(a.rule) : `${t('AVWAP')} ${n}`, open = editing === a.id;
    const swatch = lineSwatch(a.color ?? anchorDefault(a.slot, p), a.color !== undefined, name, color => store.set({ vwap: changeAnchor(store.state.vwap, coin, a.id, { color }) }), rebuild);
    // Where it starts: a live one's as its rule lands now (read again every two seconds while the panel is open: it moves with new highs).
    const when = el('span', { class: 'desc anchor-when' });
    const read = (): Resolved => a.rule ? ruleStart(a.rule) : { state: 'ready', at: a.at! };
    const say = (): void => {
      const r = read(), code = a.rule ? `${t('AVWAP')} ${ruleCode(a.rule)} · ` : '';
      when.textContent = code + (r.state === 'ready' ? t('from {time}', { time: clockYear(r.at) }) : r.state === 'coming' ? t('finding it…') : t('no candle in this period yet'));
    };
    say();
    if (a.rule) { const timer = window.setInterval(() => { if (!when.isConnected) window.clearInterval(timer); else say(); }, 2_000); }
    const eye = el('button', { type: 'button', class: 'anchor-eye', ariaLabel: a.hidden ? t('Show {line}', { line: name }) : t('Hide {line}', { line: name }), tip: a.hidden ? t('Show this line') : t('Hide this line, keeping it') });
    eye.dataset.hidden = String(!!a.hidden); eye.setAttribute('aria-pressed', String(!a.hidden));
    eye.onclick = () => { store.set({ vwap: changeAnchor(store.state.vwap, coin, a.id, { hidden: !a.hidden }) }); rebuild(); };
    const edit = el('button', { type: 'button', class: 'anchor-edit', textContent: open ? t('Done') : t('Edit'), ariaExpanded: String(open),
      tip: a.rule ? t('Freeze it at its candle, or move it to another') : t('Change its date, or click another candle'), onclick: () => { editing = open ? null : a.id; rebuild(); } });
    const x = el('button', { type: 'button', class: 'session-remove', ariaLabel: t('Remove {line}', { line: name }), tip: t('Remove this anchor'), onclick: () => remove(a, index, name) });
    body.append(el('div', { class: `anchor-row${a.hidden ? ' hidden-one' : ''}` }, swatch.swatch,
      el('span', { class: 'anchor-what' }, el('span', { class: 'name', textContent: name }), when), ...(swatch.reset ? [swatch.reset] : []), eye, edit, x));
    if (open) body.append(anchorEditor(store, rebuild, a, name, read));
  });
  if (!list.length) body.append(note(t('No anchors yet for this coin.')));
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
  body.append(note(t('High so far moves to each new high as it prints; previous high and low change when a new period begins. In the zone the Volume profile and Key levels use.')));
  // A date: where the line would start is said before it is added.
  body.append(el('p', { class: 'anchor-sub', textContent: t('From a date') }), dateField({
    focus: 'vwap-anchor-new', action: t('Add'), reachMs: ANCHOR_REACH_MS, tooOld: t('Too far back: an anchor reaches ten years.'), full: fullWhy,
    add: at => put(withAnchor(store.state.vwap, coin, { at }, Date.now()), t('An anchor starts at that minute already.')),
  }));
  // A candle on the chart: armed, the next click there places it (a drag still pans; Esc stops).
  const armed = store.state.vwapAnchoring && store.state.anchorMove === null;
  const place = el('button', { type: 'button', textContent: armed ? t('Cancel') : t('Click a candle'), disabled: full && !armed, tip: fullWhy ?? t('Then click the candle on the map where the average should start.'),
    onclick: () => { store.set(armed ? { vwapAnchoring: false } : { vwapAnchoring: true, anchorMove: null, rangeTool: false }); rebuild(); } });
  body.append(el('p', { class: 'anchor-sub', textContent: t('From a candle') }), el('div', { class: 'session-add' }, place));
  if (armed) body.append(note(t('Click the candle on the map where the average should start; the arrow keys and Enter work too. Esc cancels.')));
}

/**
 * An anchor's editor, under its row: a live one is frozen at the candle its rule lands on now (it stops following the rule), or moved to a
 * candle clicked; a fixed one is moved to a date typed or to a candle clicked. Moved or frozen, it stays fixed there from then on.
 */
function anchorEditor(store: Store, rebuild: () => void, a: Anchor, name: string, read: () => Resolved): HTMLElement {
  const coin = currentCoin().coin, box = el('div', { class: 'anchor-editor' });
  const moving = store.state.vwapAnchoring && store.state.anchorMove === a.id;
  const pick = el('button', { type: 'button', textContent: moving ? t('Cancel') : t('Click a candle'), tip: t('Then click the candle on the map to move it there.'),
    onclick: () => { store.set(moving ? { vwapAnchoring: false, anchorMove: null } : { vwapAnchoring: true, anchorMove: a.id, rangeTool: false }); rebuild(); } });
  const moved = (next: VwapSettings): void => {
    if (next === store.state.vwap) { toast(t('An anchor starts at that minute already.')); return; }
    store.set({ vwap: next }); editing = null; rebuild();
  };
  if (a.rule) {
    const r = read();
    const freeze = el('button', { type: 'button', textContent: t('Freeze here'), disabled: r.state !== 'ready', tip: t('Keep it at this candle: it stops following the rule.'),
      onclick: () => { const now = read(); if (now.state === 'ready') moved(changeAnchor(store.state.vwap, coin, a.id, { at: now.at })); } });
    box.append(el('div', { class: 'session-add' }, freeze, pick),
      note(r.state === 'ready' ? t('Freeze keeps {line} at {time}: it no longer moves on.', { line: name, time: clockYear(r.at) }) : t('It can be frozen once its candle is found.')));
  } else {
    box.append(dateField({ focus: `vwap-anchor-${a.id}`, action: t('Move'), value: a.at ?? null, reachMs: ANCHOR_REACH_MS, tooOld: t('Too far back: an anchor reaches ten years.'),
      add: at => moved(changeAnchor(store.state.vwap, coin, a.id, { at })) }), el('div', { class: 'session-add' }, pick));
  }
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
