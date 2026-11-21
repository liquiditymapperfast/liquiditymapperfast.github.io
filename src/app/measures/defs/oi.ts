import { t } from '../../i18n.ts';
import { usd } from '../../format.ts';
import type { OiBar } from '../../store.ts';
import type { OiPart } from '../../oi-change.ts';
import { ensureDeltaFlow } from '../../delta/flows.ts';
import { flowLoadIds } from '../../cvd/ids.ts';
import { replaying } from '../../replay/clock.ts';
import { oiInstrument } from '../../../shared/oi-profile.ts';
import { MAX_PROFILE_INSTRUMENTS } from '../../../shared/footprint.ts';
import { bucketFor, oiRows, oiSpread, readingSpacing } from '../model.ts';
import { Asked, NO_FLAGS, emptyAnswer, worked, type MeasureDef, type TimeWorker } from '../measure.ts';

const MINUTE = 60_000;

/** A signed USD amount: +$1.2M, −$300K. */
const signed = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${usd(Math.abs(v))}`;

/**
 * The change in open interest: each perpetual's change between its readings spread over the prices (or the minutes) that traded on it in
 * between, by their share of its volume (shared/oi-profile.ts, `oiSpread`): where exposure grew, then where it shrank, each venue on its own,
 * linear markets' coins valued at the prices that traded and inverse ones in their own USD. An estimate of where, never of who.
 */
export const OI: MeasureDef<'oi'> = {
  id: 'oi',
  name: () => t('Open interest change'), short: () => t('OI change'),
  tip: () => t('Where open interest grew or shrank, an estimate.'),
  words: () => ({ buy: t('Open interest added'), sell: t('Open interest removed'), net: t('Net change'), share: t('Share of the change'), none: t('No change in open interest placed at these prices.') }),
  stretchNone: () => t('Open interest did not change in this stretch.'),
  unit: 'usd', completeness: ['unplaced'],
  // What was added and what was removed, and the change it could not place when that is more than a hundredth of what it placed.
  header(rows, flags) {
    const head = t('OI CHANGE');
    if (!rows) return { head, sub: '', warn: false };
    let up = 0, down = 0; for (let i = 0; i < rows.buy.length; i++) { up += rows.buy[i]!; down += rows.sell[i]!; }
    const unplaced = flags.unplaced ?? 0, total = t('OI +{up} −{down}', { up: usd(up), down: usd(down) });
    return Math.abs(unplaced) > (up + down) / 100 ? { head: total, sub: t('{value} not placed', { value: signed(unplaced) }), warn: true } : { head: total, sub: t('ROW MAX {value}', { value: usd(rows.max) }), warn: false };
  },
  priceNotes: ({ browser }) => [
    t('Each perpetual\'s change in open interest between its readings (about one a minute) spread over the prices that traded on it in between, by their share of the volume: where exposure grew (bid colour) and where it shrank (ask colour). An estimate of where, never of who: a change does not say which side opened or closed. Each venue counts on its own, and a change with no trades recorded under it, or between readings an hour apart, is not placed: the header says how much.'),
    ...(browser ? [t('This page keeps a day of the open-interest readings it takes while it is open: Binance, Bybit and OKX also read back their five-minute history, Hyperliquid, Bitget and Deribit have only what the page took.')] : []),
  ],
  timeNote: () => t('Where open interest grew (bid colour) and where it shrank (ask colour) in each stretch, each perpetual on its own, from its readings by the minute whatever the chart\'s timeframe: each change spread over the minutes it came about in by their volume and valued at the prices that traded, as the column does by price. A change across more than an hour, or with nothing traded under it, is not placed, and the header says how much. It never says who bought or sold.'),
  judgedByMarks: false, rangeAddsUp: false, perpetualsOnly: true,
  byPrice: {
    instruments: ids => ids.filter(oiInstrument).slice(0, MAX_PROFILE_INSTRUMENTS),
    keyOf: id => id,
    ask: (source, ids, from, to, step) => !ids.length ? Promise.resolve({ answer: emptyAnswer(from, to), flags: NO_FLAGS })
      : source.oiProfile ? source.oiProfile(ids, from, to, step).then(answer => ({ answer, flags: { ...NO_FLAGS, unplaced: answer.unplaced } }))
      : Promise.reject(new Error('no open-interest profile from this source')),
  },
  byTime: { worker: oiWorker },
};

/**
 * Open interest by time: the columns' perpetuals read by the minute from ten minutes before the window, so its first reading has one before
 * it, whatever the chart's timeframe (a candle's ups and downs are not netted); their flow places each change in time and its prices value
 * it, as the column's footprint does by price.
 */
function oiWorker(): TimeWorker {
  const series = new Asked<{ ids: string; parts: OiPart[] }>();
  return {
    work(q, last) {
      const { from: of, to: ot } = q.whole;
      const oiIds = q.ids.filter(oiInstrument).slice(0, MAX_PROFILE_INSTRUMENTS), base = oiIds.join(','), askFrom = Math.floor((of - 10 * MINUTE) / MINUTE) * MINUTE, askTo = Math.ceil(ot / MINUTE) * MINUTE + MINUTE;
      series.ensure(base, askFrom, askTo, q.live, async () => ({ ids: base, parts: (await Promise.all(oiIds.map(async id => ({ id, ...await q.hub.oiSeries(id, '1m', askFrom, askTo).catch(() => ({ bars: [] as OiBar[] })) })))).filter(p => p.bars.length) }), q.loaded);
      const { step, limit } = bucketFor(q.span, q.pw, MINUTE);
      const key = `o|${step}|${of}|${ot}|${q.second}|${series.version}|${q.hub.flow.loads}`;
      if (last?.key === key) return last;
      ensureDeltaFlow(q.hub, flowLoadIds(q.state, q.hub.flow.ids), of, Date.now());
      // Replay: only the minutes that had ended by its moment.
      const parts = (series.held?.parts ?? []).map(p => ({ ...p, bars: replaying() ? p.bars.filter(b => b[0] + MINUTE <= q.now) : p.bars }));
      const spread = oiSpread(parts.map(p => ({ ...p, track: q.hub.flow.track(p.id) })), of, ot, q.state.mark.price);
      return worked(q, key, [], oiRows(spread.parts, spread.covered, of, ot, step, spread.first), limit,
        { spacingMs: readingSpacing(parts.map(p => p.bars)), flags: { ...NO_FLAGS, unplaced: spread.unplaced }, since: of > q.win.from + MINUTE ? of : null });
    },
  };
}
