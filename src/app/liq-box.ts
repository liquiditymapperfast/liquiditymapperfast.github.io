/**
 * What Liquidation levels' boxes and readings say, apart from where they are drawn (pure, tested in tests/app-liq-plus.test.mts): the stripe's
 * box for a row, the column's reading at the pointer, its Mirror box's parts and the phone Liq tab's finger. Every amount is in dollars
 * (`dollars`), and under each total of Liq + stops its two parts, which add up to the figure above them as it is printed (`splitText` with
 * that figure).
 */
import { INFO, type InfoLine } from './infobox.ts';
import { t } from './i18n.ts';
import { usd } from './format.ts';
import { distanceText } from './panes/ladder-info.ts';
import { onTheWay, partsBetween, partsOnTheWay, type LevelsKind, type LiqParts, type LiqRow, type LiqSet, type LiqStanding } from './liq-levels.ts';
import { countLabel, ordersAbsent, sideTitle, splitLabel, splitText, topLabel } from './liq-words.ts';

/** An amount as the boxes write it: "$1.2M". */
export const dollars = (value: number): string => `$${usd(value)}`;

/**
 * The stripe's box for a row under the pointer (`HeatPane.#liquidationLines` finds the row), for each side `shown` holds: what is at that
 * level (and how much of it still stands), how far it is from the price, how much is on the way there (the liquidation column's curve at the
 * level's far edge), how many positions or orders make it up and how big the largest is, and its two parts (isolated and cross margin;
 * whole-position orders and orders with their own size). Liq + stops (`parts`) gives both of its figures as their total and its two parts.
 * `whose` names the group of a lane that has one beside another group's (everyone beside the profitable traders, `stripePlan`), after each
 * side's title ("Long liquidations · Profitable"); null names none.
 */
export function stripeBoxLines(row: LiqRow, kind: LevelsKind, price: number, standing: LiqStanding | null, parts: LiqParts | null, shown: (side: 'long' | 'short') => boolean, whose: string | null = null): InfoLine[] {
  const lines: InfoLine[] = [];
  for (const side of ['long', 'short'] as const) {
    if (!shown(side)) continue;
    const total = row[side], left = row[`${side}Left`], iso = row[`${side}Iso`], top = row[`${side}Top`];
    // In the colour it is drawn in: what sells in the falling colour, what buys in the rising one (take profits of shorts are buys).
    const sells = kind === 'takes' ? side === 'short' : side === 'long';
    lines.push({ text: whose ? `${sideTitle(kind, side)} · ${whose}` : sideTitle(kind, side), color: sells ? 'sell' : 'buy', bold: true, rule: true });
    // What still stands, said first wherever it prints differently from the whole (Sol's review, round 2: a level 0.4 % gone printed the whole
    // and its standing parts scaled back up to it); the split is of what still stands, so it adds up to the figure said first.
    const taken = usd(left) !== usd(total);
    lines.push({ label: t('At this level'), text: taken ? t('{left} of {total}', { left: dollars(left), total: dollars(total) }) : dollars(total), bold: true });
    if (parts) lines.push({ text: splitText(partsBetween(parts, side, row.p0, row.p1), left), color: 'muted', wrap: true });
    // Measured from the edge price reaches first; on the way there, everything that still stands between the price and this level.
    const edge = side === 'long' ? row.p1 : row.p0;
    if (price > 0) lines.push({ label: t('Distance'), text: distanceText(edge, price) });
    if (price > 0 && standing) {
      // To the edge price reaches last, so the level itself counts; the column's curve and its reading at the pointer use the same sum.
      const far = side === 'long' ? row.p0 : row.p1, way = onTheWay(standing, price, far), usdWay = way?.side === side ? way.usd : 0;
      lines.push({ label: t('If price gets here'), text: dollars(usdWay) });
      const split = parts && way?.side === side ? partsOnTheWay(parts, price, far) : null;
      if (split) lines.push({ text: splitText(split, usdWay), color: 'muted', wrap: true });
    }
    lines.push({ label: countLabel(kind), text: String(row[`${side}Wallets`]) });
    if (top > 0) lines.push({ label: topLabel(kind), text: `${dollars(top)} (${Math.round(top / total * 100)}%)` });
    if (!parts) lines.push({ label: splitLabel(kind), text: `${dollars(iso)} / ${dollars(total - iso)}` });
  }
  return lines;
}

/**
 * The stripe's box for a row of a lane drawn from a set of its own (a split's right lane: the stops of the chosen traders, or the profitable
 * traders' levels), as `stripeBoxLines` writes it from that set alone, its group named where `whose` gives one; where the set's stop and
 * take-profit orders are not on the server (the profitable traders'), it says so under them, never anything of everyone's in their place.
 */
export function setBoxLines(row: LiqRow, set: Pick<LiqSet, 'levels' | 'standing' | 'partStandings' | 'ordersAbsent'>, price: number, shown: (side: 'long' | 'short') => boolean, whose: string | null = null): InfoLine[] {
  const kind = set.levels?.kind;
  if (!kind) return [];
  const lines = stripeBoxLines(row, kind, price, set.standing(), kind === 'both' ? set.partStandings() : null, shown, whose);
  return set.ordersAbsent() ? [...lines, { text: ordersAbsent(), color: 'muted', wrap: true, rule: true }] : lines;
}

/**
 * The column's reading at `at` (`way`, what goes on the way there from `price`): the arrow, the distance and the amount (`full`), the arrow
 * and the amount where that does not fit (`short`), and for Liq + stops the total and its parts under them (`split`).
 */
export function readingTexts(way: { side: 'long' | 'short'; usd: number }, price: number, at: number, parts: LiqParts | null): { full: string; short: string; split: string | null } {
  const pct = Math.abs(at - price) / price * 100, arrow = way.side === 'long' ? '▼' : '▲', money = dollars(way.usd);
  const split = parts ? partsOnTheWay(parts, price, at) : null;
  return { full: `${arrow} ${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}% · ${money}`, short: `${arrow} ${money}`, split: split ? splitText(split, way.usd) : null };
}

/**
 * The column's Mirror box for Liq + stops: under each side's total (`below`, the longs from the price down `d`; `above`, the shorts as far up),
 * its two parts, adding up to that total as printed.
 */
export function mirrorSplits(parts: LiqParts, price: number, d: number, below: number, above: number): { long: string; short: string } {
  return { long: splitText(partsBetween(parts, 'long', price - d, price), below), short: splitText(partsBetween(parts, 'short', price, price + d), above) };
}

/** The least a finger's box says (`probeBoxLines`' `detail`). */
export const PROBE_LEAST = 3;
/**
 * How wide a line of a finger's box on the split ladder may run before it wraps, on a ladder `W` px wide: the ladder less the box's padding
 * and 2 px each side, between 120 and 300 px. The boxes' own 250 px made a 266 px box on a 320 px phone's 260 px ladder, and wrapped a group
 * title that fits a wider one.
 */
export const probeWrap = (W: number): number => Math.max(120, Math.min(300, W - 2 * INFO.pad - 4));
/** What a finger reads at its price in one set: `probeBoxLines`' figures. */
export interface ProbeFacts { kind: LevelsKind; side: 'long' | 'short'; at: number; price: number; way: number; other: number; level: number; lo: number; hi: number; positions: number; top: number; parts: LiqParts | null }

/**
 * The phone Liq tab's box at a finger's price `at`: the side, the distance, what goes on the way there (`way`), what is at that level (`level`,
 * the row [lo, hi)), for Liq + stops each with its parts under it, how many and the largest, and the same distance the other way (`other`).
 * `whose` names the set's group after the title where the two halves of a split ladder are two groups ("Long liquidations · Profitable", as
 * the stripe's box says it), its last word, the dot and the group kept together where the title wraps. `detail` says less where a split
 * ladder is too short for both boxes (`probeDetail`): from 1 without the count, the largest and the other side; from 2 without the distance
 * too (the same in both boxes, and on the finger's tag); at 3 (`PROBE_LEAST`) without the level, keeping what goes on the way there. A total
 * of liquidations and stops keeps its two parts under it at every detail.
 */
export function probeBoxLines(f: ProbeFacts, o: { detail?: number; whose?: string | null } = {}): InfoLine[] {
  const way = Math.max(0, f.way), waySplit = f.parts ? partsOnTheWay(f.parts, f.price, f.at) : null, sells = f.kind === 'takes' ? f.side === 'short' : f.side === 'long';
  const detail = o.detail ?? 0, title = sideTitle(f.kind, f.side);
  const lines: InfoLine[] = [
    // In the colour it is drawn in: what sells in the falling colour (take profits of longs, above), what buys in the rising one.
    o.whose ? { text: `${title}\u00a0·\u00a0${o.whose}`, color: sells ? 'sell' : 'buy', bold: true, wrap: true } : { text: title, color: sells ? 'sell' : 'buy', bold: true },
    ...(detail < 2 ? [{ label: t('Distance'), text: distanceText(f.at, f.price) } satisfies InfoLine] : []),
    { label: t('If price gets here'), text: dollars(way), bold: true },
    ...(waySplit ? [{ text: splitText(waySplit, way), color: 'muted', wrap: true } satisfies InfoLine] : []),
  ];
  if (detail < 3) {
    lines.push({ label: t('At this level'), text: dollars(f.level) });
    if (f.parts && f.level > 0) lines.push({ text: splitText(partsBetween(f.parts, f.side, f.lo, f.hi), f.level), color: 'muted', wrap: true });
  }
  if (detail > 0) return lines;
  if (f.positions > 0) lines.push({ label: countLabel(f.kind), text: String(f.positions) });
  if (f.top > 0 && f.level > 0) lines.push({ label: topLabel(f.kind), text: dollars(f.top) });
  lines.push({ label: t('Same distance, other side'), text: dollars(Math.max(0, f.other)), color: sells ? 'buy' : 'sell' });
  return lines;
}
