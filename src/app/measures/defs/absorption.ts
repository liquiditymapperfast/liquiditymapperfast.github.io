import { t } from '../../i18n.ts';
import { usd } from '../../format.ts';
import type { ProfileAnswer } from '../../../shared/footprint.ts';
import { AbsorptionProfile, MAX_ABSORPTION_INSTRUMENTS, type AbsorptionGroup } from '../../../shared/absorption.ts';
import { bucketFor, eventRows, type TimeEvent } from '../model.ts';
import { NO_FLAGS, emptyAnswer, worked, type MeasureDef, type Thresholds, type TimeWorker } from '../measure.ts';

/**
 * Absorption: the marked part of each absorption group (shared/absorption.ts `AbsorptionProfile`, counted once a group) at the threshold the
 * Absorption settings judge it at: market sells that met resting buyers, then market buys that met resting sellers, in USD. By price the
 * source adds them up where they are kept (`DataSource.absorptionProfile`); by time, the marks' own groups the page holds.
 */
export const ABSORPTION: MeasureDef<'absorption'> = {
  id: 'absorption',
  name: () => t('Absorption'), short: () => t('Absorption'),
  tip: () => t('Market orders that resting orders took, at each price.'),
  words: () => ({ buy: t('Resting buyers took'), sell: t('Resting sellers took'), net: t('Difference'), share: t('Share of the absorbed'), none: t('Nothing absorbed at these prices in this window.') }),
  stretchNone: () => t('Nothing absorbed in this stretch.'),
  unit: 'usd', completeness: ['cut', 'incomplete'],
  header(rows, flags) {
    const head = t('ABSORBED');
    if (!rows) return { head, sub: '', warn: false };
    const total = t('ABSORBED {value}', { value: usd(rows.total) });
    if (flags.cut) return { head: total, sub: t('the largest only'), warn: true };
    if (flags.incomplete) return { head: total, sub: t('some minutes in part'), warn: true };
    return { head: total, sub: t('ROW MAX {value}', { value: usd(rows.max) }), warn: false };
  },
  priceNotes: () => [t('The absorption marks at the threshold the Absorption settings judge them at, each counted once: market sells resting buyers took (bid colour) and market buys resting sellers took (ask colour). Where a minute kept only its largest groups, the header says so.')],
  timeNote: () => t('The absorption marks at the threshold the Absorption settings judge them at, on the column\'s markets: market sells resting buyers took (bid colour) and market buys resting sellers took (ask colour). They are loaded for the time on the chart while this shows, marks on or off.'),
  judgedByMarks: true, rangeAddsUp: false, perpetualsOnly: false,
  byPrice: {
    // The instruments with a threshold, at it exactly (one with none yet has nothing marked).
    instruments: (ids, thresholds) => ids.filter(id => typeof thresholds.get(id) === 'number').slice(0, MAX_ABSORPTION_INSTRUMENTS),
    keyOf: (id, thresholds) => `${id}:${thresholds.get(id)}`,
    // Added up where the groups are kept, every one of the window and no minutes (the thresholds are the marks', `Hub.ensureAbsorption`).
    ask: (source, ids, from, to, step, thresholds) => !ids.length ? Promise.resolve({ answer: emptyAnswer(from, to), flags: NO_FLAGS })
      : source.absorptionProfile(ids, ids.map(id => thresholds.get(id)!), from, to, step).then(answer => ({ answer, flags: { cut: answer.cut.length > 0, incomplete: answer.incomplete.length > 0 } })),
  },
  byTime: { worker: absorptionWorker },
};

/**
 * The marked part of each absorption group that began in [from, to), at its instrument's threshold (none: nothing of it is marked), by
 * price on rows of `step`: market sells taken by resting buyers, then market buys taken by resting sellers, in USD.
 */
export function absorptionAnswer(groups: readonly AbsorptionGroup[], thresholds: Thresholds, from: number, to: number, step: number): ProfileAnswer {
  // Added up as a source adds them (shared/absorption.ts `AbsorptionProfile`).
  const out = new AbsorptionProfile(thresholds, from, to, step);
  for (const g of groups) out.add(g);
  return out.answer();
}

/** Absorption by time: the marks' groups at the marks' thresholds, each its marked part, on the instruments the column judges. */
function absorptionWorker(): TimeWorker {
  return {
    work(q, last) {
      const { thresholds } = q.absorption(), book = q.hub.absorption, { from, to } = q;
      const { step, limit } = bucketFor(q.span, q.pw);
      const judged = q.ids.filter(id => typeof thresholds.get(id) === 'number').slice(0, MAX_ABSORPTION_INSTRUMENTS);
      const key = `a|${step}|${from}|${q.second}|${judged.join(',')}|${book.version}|${q.hub.absorptionState}`, refs = [thresholds];
      if (last?.key === key && last.refs.every((r, i) => r === refs[i])) return last;
      // Market sells resting buyers took first (bid colour), then market buys resting sellers took (ask colour).
      const marks = book.marks(judged, thresholds, from, to, -Infinity, Infinity).filter(m => m.t0 >= from && m.t0 < to);
      const events = marks.map((m): TimeEvent => ({ t: m.t0, side: m.side === 'sell' ? 0 : 1, usd: m.usd }));
      const cut = judged.some(id => { const least = q.hub.absorptionCut.get(id), threshold = thresholds.get(id); return least !== undefined && threshold !== null && threshold !== undefined && least >= threshold; });
      // Where a busy minute kept only its largest groups and left out one that was a mark: judged from the minutes' floors by the column's own
      // rule (`AbsorptionProfile`), so the band says "some minutes in part" when the column does.
      const judge = new AbsorptionProfile(new Map(judged.map(id => [id, thresholds.get(id) ?? null])), from, to, 1);
      for (const m of marks) judge.marked(m.id, m.side, m.price, m.t0, m.usd);
      for (const id of judged) { const floor = book.floorIn(id, from, to); if (floor !== undefined) judge.floor(id, null, floor); }
      const incomplete = judge.answer().incomplete.length > 0;
      return worked(q, key, refs, eventRows(events, from, to, step, book.cover), limit, { flags: { cut, incomplete }, unavailable: q.hub.absorptionState === 'unavailable' });
    },
  };
}
