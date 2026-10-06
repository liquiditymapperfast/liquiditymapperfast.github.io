import { el } from '../dom.ts';
import type { Store } from '../store.ts';
import { button, heading, note, rangeRow, selectRow, switchRow } from '../ui.ts';
import { MIN_TIER_USD, readSounds, type SoundSettings } from './rules.ts';
import type { Sounds } from './sounds.ts';
import { usd as formatUsd } from '../format.ts';
import { t, tn } from '../i18n.ts';

/** Contents of the Sounds panel: a master switch, volume, which trades count, the size tiers (each with a Test), and the candle chime. */
export function buildSoundPanel(store: Store, sounds: Sounds, rerender: () => void, tools: HTMLElement, body: HTMLElement): void {
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
    const amount = el('input', { type: 'number', min: String(MIN_TIER_USD), step: '10000', value: String(tier.usd), tip: t('Smallest trade in this tier, USD notional (at least {min})', { min: formatUsd(MIN_TIER_USD) }) });
    amount.onchange = () => { const v = Number(amount.value); if (Number.isFinite(v)) setTier(tier.id, { usd: v }); };
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
}
