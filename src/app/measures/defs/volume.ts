import { t } from '../../i18n.ts';
import { VOLUME_WORDS, tradedHeader } from '../../traded.ts';
import { ensureDeltaFlow } from '../../delta/flows.ts';
import { flowLoadIds } from '../../cvd/ids.ts';
import { bucketFor, flowRows, minuteFlowAt } from '../model.ts';
import { NO_FLAGS, worked, type MeasureDef } from '../measure.ts';

const MINUTE = 60_000;

/**
 * Traded volume: what was bought and sold at market. By price, the footprint's rows of the columns' markets (`DataSource.profile`); by
 * time, the flow column's running sums (`flowRows`), to the second for the last day the page holds and to the minute before it.
 */
export const VOLUME: MeasureDef<'volume'> = {
  id: 'volume',
  name: () => t('Traded volume'), short: () => t('Volume'),
  tip: () => t('What was bought and sold at market at each price.'),
  words: () => VOLUME_WORDS,
  stretchNone: () => t('Nothing traded in this stretch.'),
  unit: 'usd', completeness: ['partial'],
  header: rows => { const [head, sub] = tradedHeader(rows); return { head, sub, warn: rows?.partial === true }; },
  priceNotes: () => [],
  timeNote: () => t('Bought and sold at market in each stretch, on the columns\' markets: to the second for the last day the page holds, to the minute before it, where a bar is a minute at least. Ten minutes or more with no trade on any of them counts as not recorded.'),
  judgedByMarks: false, rangeAddsUp: true, perpetualsOnly: false,
  byPrice: {
    instruments: ids => [...ids],
    keyOf: id => id,
    ask: (source, ids, from, to, step) => source.profile(ids, from, to, step).then(answer => ({ answer, flags: NO_FLAGS })),
  },
  byTime: {
    worker: () => ({
      work(q, last) {
        const tracks = q.ids.flatMap(id => { const k = q.hub.flow.track(id); return k ? [k] : []; });
        const { step, limit } = bucketFor(q.span, q.pw, minuteFlowAt(tracks, q.from) ? MINUTE : 0);
        const key = `v|${step}|${q.from}|${q.second}|${q.ids.join(',')}|${q.hub.flow.loads}`;
        if (last?.key === key) return last;
        ensureDeltaFlow(q.hub, flowLoadIds(q.state, q.hub.flow.ids), q.from, Date.now());
        return worked(q, key, [], flowRows(tracks, q.from, q.to, step, q.now), limit);
      },
    }),
  },
};
