import { t } from '../../i18n.ts';
import { usd } from '../../format.ts';
import { binOf, type FootprintRow, type ProfileAnswer } from '../../../shared/footprint.ts';
import { LIQUIDATIONS_PER_ANSWER, type Liquidation } from '../../../shared/liquidations.ts';
import { bucketFor, eventRows, type TimeEvent } from '../model.ts';
import { Asked, worked, type MeasureDef, type TimeWorker } from '../measure.ts';

/**
 * Liquidations: the positions the venues closed by force, at the price the market was at (shared/liquidations.ts), in USD as reported:
 * shorts liquidated (forced buys) first, then longs liquidated (forced sells). Only the venues that publish them count, Binance at most one a
 * market a second, so it is what was reported, not all there was; the source answers its largest 5,000 when more match.
 */
export const LIQUIDATIONS: MeasureDef<'liquidations'> = {
  id: 'liquidations',
  name: () => t('Liquidations'), short: () => t('Liquidations'),
  tip: () => t('Reported liquidations at each price.'),
  words: () => ({ buy: t('Shorts liquidated'), sell: t('Longs liquidated'), net: t('Difference'), share: t('Share of the liquidations'), none: t('No liquidation reported at these prices in this window.') }),
  stretchNone: () => t('No liquidation reported in this stretch.'),
  unit: 'usd', completeness: ['cut'],
  header(rows, flags) {
    const head = t('LIQUIDATED');
    if (!rows) return { head, sub: '', warn: false };
    const total = t('LIQUIDATED {value}', { value: usd(rows.total) });
    if (flags.cut) return { head: total, sub: t('the largest 5,000'), warn: true };
    return { head: total, sub: t('ROW MAX {value}', { value: usd(rows.max) }), warn: false };
  },
  priceNotes: () => [t('Liquidations as the venues report them: shorts liquidated, forced buys (bid colour), and longs liquidated, forced sells (ask colour). Only Binance, Bybit, OKX and Deribit report them, Binance at most one a market a second, so this is what was reported, not all there was.')],
  timeNote: () => t('Liquidations as the column adds them up, every size the record keeps: shorts liquidated (bid colour) and longs liquidated (ask colour). Where the time on the chart holds more than 5,000, only the largest are counted, and the header says so.'),
  judgedByMarks: false, rangeAddsUp: false, perpetualsOnly: true,
  byPrice: {
    instruments: ids => [...ids],
    keyOf: id => id,
    ask: (source, ids, from, to, step) => source.liquidations
      ? source.liquidations(from, to).then(rows => ({ answer: liquidationAnswer(rows, ids, from, to, step), flags: { cut: rows.length >= LIQUIDATIONS_PER_ANSWER, incomplete: false } }))
      : Promise.reject(new Error('no liquidations from this source')),
  },
  byTime: { worker: liquidationWorker },
};

/** Liquidations of `ids` in [from, to) by price on rows of `step`: shorts liquidated, then longs liquidated, in USD. */
export function liquidationAnswer(rows: readonly Liquidation[], ids: readonly string[], from: number, to: number, step: number): ProfileAnswer {
  const wanted = new Set(ids), by = new Map<string, Map<number, [number, number]>>();
  for (const l of rows) if (wanted.has(l.id) && l.t >= from && l.t < to && l.price > 0) {
    let bins = by.get(l.id); if (!bins) { bins = new Map(); by.set(l.id, bins); }
    const bin = binOf(l.price, step), cell = bins.get(bin) ?? [0, 0]; cell[l.side === 'short' ? 0 : 1] += l.usd; bins.set(bin, cell);
  }
  return {
    from, to,
    instruments: [...by].map(([id, bins]) => ({
      id, step, minutes: 0, first: null, earliest: null,
      rows: [...bins].sort((a, b) => a[0] - b[0]).map(([bin, [a, b]]): FootprintRow => [bin * step, a, b]),
    })),
  };
}

/** Liquidations by time: every one the source holds over the window, as the column asks for them (its largest when more). */
function liquidationWorker(): TimeWorker {
  const held = new Asked<Liquidation[]>();
  return {
    work(q, last) {
      const source = q.hub.source;
      if (source.liquidations) held.ensure('', q.from, q.to, q.live, () => source.liquidations!(q.from, q.to), q.loaded);
      const { step, limit } = bucketFor(q.span, q.pw);
      const key = `l|${step}|${q.from}|${q.second}|${q.ids.join(',')}|${held.version}`;
      if (last?.key === key) return last;
      const rows = held.held ?? [], wanted = new Set(q.ids), events: TimeEvent[] = [];
      // Shorts liquidated are forced buys (bid colour), longs liquidated forced sells (ask colour), as in the column.
      for (const l of rows) if (wanted.has(l.id)) events.push({ t: l.t, side: l.side === 'short' ? 0 : 1, usd: l.usd });
      const got = held.held !== null;
      // Read only as far as the answer held reaches: a window grown since waits for its own answer, not counted as quiet.
      return worked(q, key, [], eventRows(events, q.from, q.to, step, got ? held.answered : null), limit,
        { flags: { cut: rows.length >= LIQUIDATIONS_PER_ANSWER, incomplete: false }, unavailable: !source.liquidations || (held.failed && !got) });
    },
  };
}
