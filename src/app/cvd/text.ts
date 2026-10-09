import { usd, clock } from '../format.ts';
import type { InfoLine } from '../infobox.ts';
import { venueLabel } from '../venues.ts';
import { t } from '../i18n.ts';
import { scaledUsd } from '../coin.ts';
import type { Kind } from '../scope.ts';
import type { CvdModel, FamilyRow, LaneLine } from './model.ts';

/** A signed dollar figure for a label: +$12.3M, −$4.1M, $0. */
export const signedUsd = (value: number): string => !Number.isFinite(value) ? '–' : value === 0 ? '$0' : `${value < 0 ? '−' : '+'}$${usd(Math.abs(value))}`;
export const plainUsd = (value: number): string => Number.isFinite(value) ? `$${usd(value)}` : '–';

/** One line of a row's label: its text, which colour it takes, and a coloured dot ahead of it (the lane's line colour). */
/** `mark`: the exchange whose mark goes before the text (the row's name line). */
export interface LabelLine { text: string; tone: 'text' | 'muted'; bold?: boolean; dot?: Kind; mark?: string }

/** The ranking window as a short name: "1H". */
export const windowName = (rankSec: number): string => rankSec >= 86_400 ? `${Math.round(rankSec / 86_400)}D` : rankSec >= 3_600 ? `${Math.round(rankSec / 3_600)}H` : `${Math.round(rankSec / 60)}M`;

const letter = (kind: Kind): string => kind === 'spot' ? t('S') : t('P');

/**
 * What goes beside a row, in lines that fit `height` px at 12 px a line: the rank and the exchange, then each lane's delta over the
 * ranking window with a dot in the lane's colour, then the exchange's share of all volume and whether it has gone quiet. A short row
 * folds the two lanes onto one line.
 */
export function rowLabel(row: FamilyRow, window: string, height: number, showQuiet: boolean): LabelLine[] {
  const lines = Math.max(2, Math.floor((height - 6) / 12));
  const head: LabelLine = { text: `#${row.rank} ${venueLabel(row.key).toUpperCase()}${showQuiet && row.quiet ? ' !5m' : ''}`, tone: 'text', bold: true, mark: row.key };
  const lanes = row.lanes.map(l => ({ text: `${letter(l.kind)} ${signedUsd(l.delta)}`, tone: 'text' as const, dot: l.kind }));
  const share: LabelLine = { text: `${Math.round(row.share * 100)}% · ${plainUsd(row.gross)}`, tone: 'muted' };
  if (lines >= 2 + lanes.length) return [head, ...lanes, share];
  if (lines >= 3 && lanes.length === 2) return [head, { text: lanes.map(l => l.text).join('  '), tone: 'text' }, share];
  if (lines >= 3) return [head, ...lanes, share].slice(0, lines);
  return [head, lanes.length === 1 ? lanes[0]! : { text: lanes.map(l => l.text).join(' '), tone: 'text' }];
}

/**
 * The label of the aggregate row: every exchange together, and each kind's delta over the window. With the Spot or Perp filter on it says
 * which kind these are and how many exchanges the filter leaves out, so a short list is not mistaken for a missing one.
 */
export function aggregateLabel(model: CvdModel, height: number, filter?: { kind: Kind; hidden: number }): LabelLine[] {
  const name = windowName(model.rankSec);
  const head: LabelLine = { text: !filter ? t('ALL VENUES') : filter.kind === 'spot' ? t('ALL SPOT VENUES') : t('ALL PERP VENUES'), tone: 'text', bold: true };
  const lanes: LabelLine[] = ([['spot', model.spot], ['perp', model.perp]] as const).flatMap(([kind, line]) => line ? [{ text: `${letter(kind)} ${signedUsd(line.delta)}`, tone: 'text' as const, dot: kind }] : []);
  const total = (model.spot?.delta ?? 0) + (model.perp?.delta ?? 0), foot: LabelLine = { text: `Δ${name} ${signedUsd(total)}`, tone: 'muted' };
  const hidden: LabelLine[] = filter && filter.hidden > 0 ? [{ text: t('{n} filtered out', { n: filter.hidden }), tone: 'muted' }] : [];
  return height >= 80 ? [head, ...lanes, foot, ...hidden].slice(0, Math.max(3, Math.floor((height - 6) / 12))) : [head, ...lanes].slice(0, Math.max(2, Math.floor((height - 6) / 12)));
}

const lanePhrase = (kind: Kind): string => kind === 'spot' ? t('Spot') : t('Perp');

/**
 * The box under the pointer on a venue row: what each lane's running delta stands at there, then the lane's figures over the ranking
 * window (net, buy against sell) and the exchange's share. Pure, so a test reads the words.
 */
export function rowHover(row: FamilyRow, column: number, timeMs: number, window: string): InfoLine[] {
  const out: InfoLine[] = [{ text: `${venueLabel(row.key)} · #${row.rank}`, bold: true }, { text: clock(timeMs, true), color: 'muted' }];
  for (const lane of row.lanes) {
    const v = lane.last[column];
    out.push({ label: t('{kind} CVD here', { kind: lanePhrase(lane.kind) }), text: v !== undefined && Number.isFinite(v) ? signedUsd(v) : '–', rule: out.length === 2 });
  }
  for (const lane of row.lanes) {
    out.push({ label: t('{kind} net, {window}', { kind: lanePhrase(lane.kind), window }), text: signedUsd(lane.delta), rule: lane === row.lanes[0] });
    out.push({ label: t('{kind} buys / sells', { kind: lanePhrase(lane.kind) }), text: `${plainUsd(lane.buy)} / ${plainUsd(lane.sell)}` });
  }
  out.push({ label: t('Share of all volume'), text: `${(row.share * 100).toFixed(row.share < 0.1 ? 1 : 0)}%`, rule: true });
  if (row.quiet) out.push({ text: t('No trades in the last five completed minutes.'), color: 'muted', wrap: true });
  return out;
}

/**
 * The box on the aggregate row. When spot and perpetual markets are moving opposite ways by a wide margin it says so: that is the
 * pattern worth a second look (one kind of market is being hit while the other is being lifted).
 */
export function aggregateHover(model: CvdModel, column: number, timeMs: number, window: string): InfoLine[] {
  const out: InfoLine[] = [{ text: t('All venues'), bold: true }, { text: clock(timeMs, true), color: 'muted' }];
  const lines: [Kind, LaneLine | null][] = [['spot', model.spot], ['perp', model.perp]];
  for (const [kind, line] of lines) {
    if (!line) continue;
    const v = line.last[column];
    out.push({ label: t('{kind} CVD here', { kind: lanePhrase(kind) }), text: v !== undefined && Number.isFinite(v) ? signedUsd(v) : '–', rule: out.length === 2 });
  }
  for (const [kind, line] of lines) {
    if (!line) continue;
    out.push({ label: t('{kind} net, {window}', { kind: lanePhrase(kind), window }), text: signedUsd(line.delta), rule: out.at(-1)?.label?.includes('here') === true });
    out.push({ label: t('{kind} buys / sells', { kind: lanePhrase(kind) }), text: `${plainUsd(line.buy)} / ${plainUsd(line.sell)}` });
  }
  const note = divergence(model);
  if (note) out.push({ text: note, wrap: true, rule: true });
  if (model.hidden > 0) out.push({ text: t('{n} more venues have traded but are not shown.', { n: model.hidden }), color: 'muted', wrap: true });
  return out;
}

/** Spot and perpetual moving apart over the ranking window: both sides big and of opposite sign. Null when they do not. */
export function divergence(model: CvdModel, minUsd = scaledUsd(2_000_000)): string | null {
  const spot = model.spot?.delta ?? 0, perp = model.perp?.delta ?? 0;
  if (Math.abs(spot) < minUsd || Math.abs(perp) < minUsd || Math.sign(spot) === Math.sign(perp)) return null;
  return spot > 0 ? t('Spot is being bought while perpetuals are being sold.') : t('Spot is being sold while perpetuals are being bought.');
}
