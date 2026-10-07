import { el } from '../dom.ts';
import type { Store } from '../store.ts';
import { button, heading, note, numberRow, rangeRow, selectRow, switchRow } from '../ui.ts';
import { MIN_TIER_USD, readSounds, type SoundSettings } from './rules.ts';
import type { Sounds } from './sounds.ts';
import type { Alerts } from './alerts.ts';
import type { PanelSounds } from './rules.ts';
import { clock } from '../format.ts';
import { usd as formatUsd } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { scaledUsd, unscaledUsd } from '../coin.ts';

/** Contents of the Sounds panel: a master switch, volume, which trades count, the size tiers (each with a Test), and the candle chime. */
export function buildSoundPanel(store: Store, sounds: Sounds, rerender: () => void, tools: HTMLElement, body: HTMLElement, alerts: Alerts | null = null): void {
  const s = store.state.sounds;
  const set = (change: Partial<SoundSettings>): void => { store.set({ sounds: readSounds({ ...store.state.sounds, ...change }) }); rerender(); };
  const setTier = (id: string, change: Partial<SoundSettings['tiers'][number]>): void => set({ tiers: store.state.sounds.tiers.map(t => t.id === id ? { ...t, ...change } : t) });

  const locked = s.on && store.state.soundState !== 'running';
  const state = el('span', { class: 'sound-state', textContent: !s.on ? t('Sounds are off') : locked ? t('Waiting for a click: browsers keep sound locked until you click or press a key on the page') : t('Sounds are on') });
  state.dataset.state = !s.on ? 'off' : locked ? 'locked' : 'on';
  tools.append(state);

  body.append(
    switchRow(t('Play sounds'), t('Master switch. Nothing plays while this is off; the Test buttons below still do, so you can hear what you would get.'), s.on, on => { set({ on }); if (on) void sounds.engine.unlock().then(() => { store.set({ soundState: sounds.engine.state }); rerender(); }); }),
    rangeRow(t('Volume'), t('Master volume. Sounds are also compressed, so several at once never clip.'), { min: 0, max: 1, step: 0.05, value: s.volume, format: v => `${Math.round(v * 100)}%` }, volume => { store.set({ sounds: readSounds({ ...store.state.sounds, volume }) }); }),
    selectRow(t('Trades from'), t('Which markets can make a sound. Spot and perpetual follow the market type of each venue.'), [['all', t('Every enabled venue')], ['spot', t('Spot venues only')], ['perp', t('Perpetual venues only')]], s.scope, scope => set({ scope: scope as SoundSettings['scope'] })),
  );

  body.append(heading(t('Large trades')));
  body.append(note(t('A sweep that fills on several venues within a quarter of a second counts as one trade. Buys rise in pitch and sells fall; a bigger tier adds notes and loudness. A trade belongs to the highest tier it reaches, and sounds only if that tier is on.')));
  s.tiers.forEach((tier, index) => {
    const amount = el('input', { type: 'number', min: String(scaledUsd(MIN_TIER_USD)), step: String(scaledUsd(10_000)), value: String(scaledUsd(tier.usd)), tip: t('Smallest trade in this tier, USD notional (at least {min})', { min: formatUsd(scaledUsd(MIN_TIER_USD)) }) });
    amount.onchange = () => { const v = Number(amount.value); if (Number.isFinite(v)) setTier(tier.id, { usd: unscaledUsd(v) }); };
    const on = el('input', { type: 'checkbox', checked: tier.on, tip: tier.on ? t('Mute the {tier} tier', { tier: tier.name }) : t('Sound the {tier} tier', { tier: tier.name }) }); on.onchange = () => setTier(tier.id, { on: on.checked });
    body.append(el('div', { class: 'tier-row' },
      el('label', { class: 'tier-name' }, on, el('span', { class: 'name', textContent: tier.name }), el('span', { class: 'desc', textContent: tn(index + 1, '{n} note', '{n} notes') })),
      el('label', { class: 'tier-usd' }, el('span', { class: 'muted', textContent: '≥ $' }), amount),
      el('span', { class: 'tier-test' }, button(t('▲ Buy'), () => sounds.test(tier.id, 'buy'), t('Hear a {tier} buy', { tier: tier.name })), button(t('▼ Sell'), () => sounds.test(tier.id, 'sell'), t('Hear a {tier} sell', { tier: tier.name }))),
    ));
  });

  body.append(heading(t('Candles')));
  body.append(switchRow(t('Chime on unusual volume'), t('One soft chime when a candle closes with unusually large volume (the sensitivity is set in Highlights).'), s.barChime, barChime => set({ barChime })));
  body.append(note(t('Liquidation sounds are not offered: the public feeds used here carry no liquidation events.')));
  if (alerts) panelSounds(store, s.panels, alerts, set, body, rerender);
}

/** The panel sounds that can also be switched on in the pane they are about. */
export type PanelSwitch = 'flow' | 'bars' | 'depth';
const SWITCH_TEXT: Record<PanelSwitch, { name: string; tip: string }> = {
  flow: { name: t('Burst of taker flow'), tip: t('An exchange bought or sold far more at market in ten seconds than it usually does. High, two-note sweep. The burst is also marked on the column.') },
  bars: { name: t('Candle closes with a big delta'), tip: t('When a candle closes, the net taker flow of every enabled venue over it was at least this much. Mid, two-note triangle.') },
  depth: { name: t('The balance tips'), tip: t('Within 1% of the price, the bids outweigh the asks (or the other way round) by more than this share. It sounds once and again only after the book has come back. Three steps.') },
};
export const panelSwitchOn = (store: Store, which: PanelSwitch): boolean => which === 'flow' ? store.state.sounds.panels.flow.burst : which === 'bars' ? store.state.sounds.panels.bars.delta : store.state.sounds.panels.depth.imbalance;
export function setPanelSwitch(store: Store, which: PanelSwitch, on: boolean): void {
  const p = store.state.sounds.panels;
  const panels = which === 'flow' ? { ...p, flow: { ...p.flow, burst: on } } : which === 'bars' ? { ...p, bars: { ...p.bars, delta: on } } : { ...p, depth: { ...p.depth, imbalance: on } };
  store.set({ sounds: readSounds({ ...store.state.sounds, panels }) });
}
/** The same switch as in the Sounds panel, for the pane's own settings: both read and write `sounds.panels`, so they never disagree. */
export const panelSwitchRow = (store: Store, which: PanelSwitch, onChange: () => void = () => {}): HTMLElement =>
  switchRow(SWITCH_TEXT[which].name, SWITCH_TEXT[which].tip, panelSwitchOn(store, which), on => { setPanelSwitch(store, which, on); onChange(); });

/**
 * The sounds a panel may make about what is happening in it. A sound is for something rare and discrete that is worth looking up from
 * another screen for; a level or a trend that is on screen all the time is not. Each is off until chosen, has its own cool-down, and the
 * four loudest moments in ten seconds are all that can sound.
 */
function panelSounds(store: Store, p: PanelSounds, alerts: Alerts, set: (change: Partial<SoundSettings>) => void, body: HTMLElement, rerender: () => void): void {
  const change = <K extends keyof PanelSounds>(panel: K, patch: Partial<PanelSounds[K]>): void => set({ panels: { ...store.state.sounds.panels, [panel]: { ...store.state.sounds.panels[panel], ...patch } } });
  const tests = (kind: Parameters<Alerts['test']>[0], both = true): HTMLElement => el('div', { class: 'tier-test' },
    ...(both ? [button(t('▲ Buy'), () => alerts.test(kind, 'buy'), t('Hear this sound for buying')), button(t('▼ Sell'), () => alerts.test(kind, 'sell'), t('Hear this sound for selling'))] : [button(t('Test'), () => alerts.test(kind, null), t('Hear this sound'))]));

  body.append(heading(t('Per panel')));
  body.append(note(t('Each panel can make its own sound about something rare that happens in it. Everything here is off until you choose it, obeys the switch and volume above, and no more than four sounds can play in ten seconds. Rising notes mean buying, falling notes mean selling.')));

  body.append(heading(t('Flow column')),
    panelSwitchRow(store, 'flow', () => rerender()),
    numberRow(t('Smallest burst (USD)'), t('Ignore bursts smaller than this, however unusual they are for a quiet exchange.'), { min: scaledUsd(100_000), step: scaledUsd(100_000), value: scaledUsd(p.flow.usd) }, usd => change('flow', { usd: unscaledUsd(usd) })),
    numberRow(t('Sensitivity (deviations)'), t('How far outside its own normal an exchange must go: 2 is touchy, 4 is the default, 8 is only the extreme.'), { min: 2, max: 10, step: 0.5, value: p.flow.sensitivity }, sensitivity => change('flow', { sensitivity })),
    tests('flow-burst'));

  body.append(heading(t('Bar stats and footprint')),
    panelSwitchRow(store, 'bars', () => rerender()),
    numberRow(t('Smallest delta (USD)'), t('Net buys minus sells over the candle that just closed.'), { min: scaledUsd(100_000), step: scaledUsd(500_000), value: scaledUsd(p.bars.usd) }, usd => change('bars', { usd: unscaledUsd(usd) })),
    tests('bar-delta'));

  body.append(heading(t('Order book and heatmap')),
    switchRow(t('A wall appears or is pulled'), t('Within 1% of the price, a level of at least this size appears, or one that has stood for a few seconds is pulled without the price having come to it. Low, soft thud; pulled falls.'), p.book.wall, wall => change('book', { wall })),
    numberRow(t('Smallest wall (USD)'), t('Added up across the enabled venues at one price.'), { min: scaledUsd(500_000), step: scaledUsd(1_000_000), value: scaledUsd(p.book.usd) }, usd => change('book', { usd: unscaledUsd(usd) })),
    tests('wall-appeared'));

  body.append(heading(t('Depth and Liquidity Tracker')),
    panelSwitchRow(store, 'depth', () => rerender()),
    numberRow(t('Tips at (%)'), t('(bids - asks) / (bids + asks), in percent.'), { min: 30, max: 95, step: 5, value: p.depth.pct }, pct => change('depth', { pct })),
    tests('imbalance'));

  body.append(heading(t('Open interest')),
    switchRow(t('Unusual open interest change'), t('A candle closed with an open-interest change that Highlights calls unusual. Two quick ticks.'), p.oi.jump, jump => change('oi', { jump })),
    tests('oi-jump', false));

  const recent = alerts.log.slice(-5).reverse();
  body.append(heading(t('Recent')));
  body.append(recent.length ? el('div', { class: 'alert-log' }, ...recent.map(e => el('p', { class: 'panel-note', textContent: `${clock(e.at)}  ${e.text}${e.audible ? '' : ' ' + t('(not heard: sound was locked)')}` }))) : note(t('Nothing yet.')));
}
