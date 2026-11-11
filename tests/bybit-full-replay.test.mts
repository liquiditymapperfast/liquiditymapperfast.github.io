import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FullBook, parseFullDelta, parseFullSnapshot } from '../src/shared/bybit-full-book.ts';

/**
 * A real session (tests/fixtures/bybit-full-session.json: Bybit spot LDOUSDT, 2026-11-11, every orderbook.full frame as received, and two
 * snapshots as received, cut to 800 levels a side) replayed through the sync module. Its trace, state after every event, is written to
 * tests/fixtures/bybit-full-session.trace.json and is the contract the history recorder's Rust port is held to (HyperLiquidMap_History,
 * tests/full_book_replay.rs): both ports must give the same trace for the same bytes.
 */
interface Session { category: string; symbol: string; frames: { at: number; text: string }[]; snapshots: { at: number; body: string }[] }
const root = process.cwd();
const session = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/bybit-full-session.json'), 'utf8')) as Session;
const tracePath = path.join(root, 'tests/fixtures/bybit-full-session.trace.json');

/** The state that both ports must agree on after each event. */
function state(book: FullBook, event: string, result: string): Record<string, unknown> {
  // Added in ascending price order, as the Rust port's BTreeMap iterates, so both give the same bits.
  const sum = (side: Map<number, number>): number => { let s = 0; for (const [p, q] of [...side].sort((x, y) => x[0] - y[0])) s += p * q; return s; };
  return { event, result, live: book.live, u: book.u, seq: book.seq, epoch: book.epoch, auditing: book.auditing, refreshing: book.refreshing, waiting: book.waiting,
    frontiers: book.frontiers, bids: book.bids.size, asks: book.asks.size, bidUsd: sum(book.bids), askUsd: sum(book.asks), disagreements: { ...book.disagreements } };
}

export function replay(s: Session): Record<string, unknown>[] {
  const book = new FullBook(), trace: Record<string, unknown>[] = [];
  const events = [...s.frames.map(f => ({ at: f.at, kind: 'frame' as const, text: f.text })), ...s.snapshots.map((x, i) => ({ at: x.at, kind: i === 0 ? 'seed' as const : 'audit' as const, text: x.body }))]
    .sort((a, b) => a.at - b.at || (a.kind === 'frame' ? -1 : 1));
  for (const e of events) {
    // The session's own clock (ms from its start), so the audit is due 10 s after the seed as it would be live.
    const now = e.at;
    if (e.kind === 'frame') {
      const d = parseFullDelta(JSON.parse(e.text), s.symbol);
      const action = d === 'bad' ? book.fault('unreadable book frame', now) : d ? book.delta(d, now) : 'none';
      trace.push(state(book, `frame ${d && d !== 'bad' ? d.u : d}`, action));
      continue;
    }
    const snap = parseFullSnapshot(JSON.parse(e.text), s.symbol);
    assert.ok(typeof snap !== 'string', `the ${e.kind} snapshot reads: ${String(snap)}`);
    const epoch = e.kind === 'seed' ? book.epoch : book.beginRefresh(now);
    trace.push(state(book, `${e.kind} ${snap.u}`, book.snapshot(snap, epoch, now)));
  }
  return trace;
}

test('bybit full book: a real session seeds on its anchor, passes its audit and applies every delta', () => {
  const trace = replay(session);
  const seed = trace.find(t => String(t.event).startsWith('seed'))!, audit = trace.find(t => String(t.event).startsWith('audit'))!;
  assert.equal(seed.result, 'seeded', 'the seed snapshot had its anchor among the held deltas');
  assert.ok(['unchanged', 'extended'].includes(String(audit.result)), `the audit: ${String(audit.result)}`);
  // Passed: no audit pending, unless it extended the coverage, which is audited in turn.
  assert.equal(audit.auditing, audit.result === 'extended', 'passed');
  const last = JSON.parse(session.frames.at(-1)!.text).data.u as number;
  assert.equal(trace.at(-1)!.u, last, 'every frame applied, none missed');
  assert.ok(trace.every(t => t.result !== 'snapshot' && t.result !== 'reconnect'), 'no resynchronisation in a clean session');
  // The contract for the Rust port: written when missing (or asked for), compared otherwise.
  if (process.env.HLM_WRITE_TRACE === '1' || !fs.existsSync(tracePath)) fs.writeFileSync(tracePath, JSON.stringify(trace, null, 1) + '\n');
  assert.deepEqual(trace, JSON.parse(fs.readFileSync(tracePath, 'utf8')), 'the trace the recorder port is held to');
});
