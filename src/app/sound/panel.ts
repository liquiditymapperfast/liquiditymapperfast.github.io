import { el } from '../dom.ts';
import type { Store } from '../store.ts';
import { button, heading, note, rangeRow, selectRow, switchRow } from '../ui.ts';
import { MIN_TIER_USD, readSounds, type SoundSettings } from './rules.ts';
import type { Sounds } from './sounds.ts';
import { usd as formatUsd } from '../format.ts';

/** Contents of the Sounds panel: a master switch, volume, which trades count, the size tiers (each with a Test), and the candle chime. */
export function buildSoundPanel(store: Store, sounds: Sounds, rerender: () => void, tools: HTMLElement, body: HTMLElement): void {
  const s = store.state.sounds;
  const set = (change: Partial<SoundSettings>): void => { store.set({ sounds: readSounds({ ...store.state.sounds, ...change }) }); rerender(); };
  const setTier = (id: string, change: Partial<SoundSettings['tiers'][number]>): void => set({ tiers: store.state.sounds.tiers.map(t => t.id === id ? { ...t, ...change } : t) });

  const locked = s.on && store.state.soundState !== 'running';
  const state = el('span', { class: 'sound-state', textContent: !s.on ? 'Sounds are off' : locked ? 'Waiting for a click: browsers keep sound locked until you click or press a key on the page' : 'Sounds are on' });
  state.dataset.state = !s.on ? 'off' : locked ? 'locked' : 'on';
  tools.append(state);

  body.append(
    switchRow('Play sounds', 'Master switch. Nothing plays while this is off; the Test buttons below still do, so you can hear what you would get.', s.on, on => { set({ on }); if (on) void sounds.engine.unlock().then(() => { store.set({ soundState: sounds.engine.state }); rerender(); }); }),
    rangeRow('Volume', 'Master volume. Sounds are also compressed, so several at once never clip.', { min: 0, max: 1, step: 0.05, value: s.volume, format: v => `${Math.round(v * 100)}%` }, volume => { store.set({ sounds: readSounds({ ...store.state.sounds, volume }) }); }),
    selectRow('Trades from', 'Which markets can make a sound. Spot and perpetual follow the market type of each venue.', [['all', 'Every enabled venue'], ['spot', 'Spot venues only'], ['perp', 'Perpetual venues only']], s.scope, scope => set({ scope: scope as SoundSettings['scope'] })),
  );

  body.append(heading('Large trades'));
  body.append(note('A sweep that fills on several venues within a quarter of a second counts as one trade. Buys rise in pitch and sells fall; a bigger tier adds notes and loudness. A trade belongs to the highest tier it reaches, and sounds only if that tier is on.'));
  s.tiers.forEach((tier, index) => {
    const amount = el('input', { type: 'number', min: String(MIN_TIER_USD), step: '10000', value: String(tier.usd), tip: `Smallest trade in this tier, USD notional (at least ${formatUsd(MIN_TIER_USD)})` });
    amount.onchange = () => { const v = Number(amount.value); if (Number.isFinite(v)) setTier(tier.id, { usd: v }); };
    const on = el('input', { type: 'checkbox', checked: tier.on, tip: `${tier.on ? 'Mute' : 'Sound'} the ${tier.name} tier` }); on.onchange = () => setTier(tier.id, { on: on.checked });
    body.append(el('div', { class: 'tier-row' },
      el('label', { class: 'tier-name' }, on, el('span', { class: 'name', textContent: tier.name }), el('span', { class: 'desc', textContent: `${index + 1} note${index ? 's' : ''}` })),
      el('label', { class: 'tier-usd' }, el('span', { class: 'muted', textContent: '≥ $' }), amount),
      el('span', { class: 'tier-test' }, button('▲ Buy', () => sounds.test(tier.id, 'buy'), `Hear a ${tier.name} buy`), button('▼ Sell', () => sounds.test(tier.id, 'sell'), `Hear a ${tier.name} sell`)),
    ));
  });

  body.append(heading('Candles'));
  body.append(switchRow('Chime on unusual volume', 'One soft chime when a candle closes with unusually large volume (the sensitivity is set in Highlights).', s.barChime, barChime => set({ barChime })));
  body.append(note('Liquidation sounds are not offered: the public feeds used here carry no liquidation events.'));
}
