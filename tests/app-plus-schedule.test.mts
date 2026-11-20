// When the checkout recovery asks the server (src/app/plus/schedule.ts; design.md 6.3 as the page build spec section 5 keeps it) and how a
// request is given up (src/app/plus/request-timeout.ts; design.md 6.5). Virtual clocks: the monotonic and the wall clock move separately.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ATTEMPT_MS, MAX_ASKS, TabWaits, WALL_GUARD_MS, type Attempt, type Step } from '../src/app/plus/schedule.ts';
import { REQUEST_TIMEOUT_MS, withTimeout } from '../src/app/plus/request-timeout.ts';

const S = 1_000;
function clocks(): { mono: number; wall: number; c: { mono(): number; wall(): number } } {
  const t = { mono: 0, wall: Date.UTC(2026, 10, 20, 12), c: { mono: () => t.mono, wall: () => t.wall } };
  return t;
}
/**
 * Runs one attempt against a server that answers `latency` ms after each ask with `answer(n)` (its Retry-After in seconds, or null: lost).
 * Returns the send times (monotonic ms) and how it ended.
 */
function drive(t: ReturnType<typeof clocks>, attempt: Attempt, answer: (n: number) => number | undefined | null, latency = 0): { sends: number[]; answers: { at: number; wait?: number }[]; end: Step } {
  const sends: number[] = [], answers: { at: number; wait?: number }[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const step = attempt.next();
    if (step.kind === 'end') return { sends, answers, end: step };
    if (step.kind === 'wait') { t.mono += step.ms; t.wall += step.ms; continue; }
    sends.push(t.mono);
    attempt.sent();
    t.mono += latency; t.wall += latency;
    const wait = answer(sends.length);
    if (wait === null) attempt.lost();
    else { attempt.answered(wait); answers.push({ at: t.mono, ...(wait !== undefined ? { wait } : {}) }); }
  }
  throw new Error('no end');
}

test('instant answers that name no wait: asks at 0, 3, 7, 13, 22, 35, 55 and 85 s, and no ninth', () => {
  const t = clocks(), waits = new TabWaits(t.c);
  const run = drive(t, waits.attempt(), () => undefined);
  assert.deepEqual(run.sends, [0, 3, 7, 13, 22, 35, 55, 85].map(s => s * S));
  assert.equal(run.sends.length, MAX_ASKS);
  assert.equal(run.end.kind, 'end');
  assert.equal(waits.cooldownLeft(), 0, 'the backoff makes no cooldown');
  // Lost answers (no wait heard) follow the same steps.
  const t2 = clocks();
  assert.deepEqual(drive(t2, new TabWaits(t2.c).attempt(), () => null).sends, [0, 3, 7, 13, 22, 35, 55, 85].map(s => s * S));
});

test('a Retry-After of 2, 3, 60, 300 or 600 s is never shortened, within an attempt or across presses', () => {
  for (const retry of [2, 3, 60, 300, 600]) {
    for (const latency of [0, 2 * S]) {
      const t = clocks(), waits = new TabWaits(t.c);
      const sends: number[] = [], answers: number[] = [];
      // Presses every 10 s until 30 asks went or 2 hours passed; each answer names `retry`.
      while (sends.length < 30 && t.mono < 7_200 * S) {
        const run = drive(t, waits.attempt(), () => retry, latency);
        sends.push(...run.sends); answers.push(...run.answers.map(a => a.at));
        if (run.end.kind === 'end' && run.end.why === 'cooldown') assert.equal(run.sends.length, 0, 'a press during the cooldown sends nothing');
        t.mono += 10 * S; t.wall += 10 * S;
      }
      for (let i = 1; i < sends.length; i++) assert.ok(sends[i]! - answers[i - 1]! >= retry * S, `Retry-After ${retry}, latency ${latency}: ask ${i} went ${sends[i]! - answers[i - 1]!} ms after the answer`);
      assert.ok(sends.length >= 2, `Retry-After ${retry}: asked again in the end`);
    }
  }
  // The backoff counts from the send, the server's wait from the answer: Retry-After 2 answered 2 s after the send gives the next at 4 s, not 3.
  const t = clocks(), attempt = new TabWaits(t.c).attempt();
  assert.deepEqual(drive(t, attempt, n => n === 1 ? 2 : undefined, 2 * S).sends.slice(0, 2), [0, 4 * S]);
});

test('an ask past the deadline is not sent; a server wait that pushed it past is the tab\'s cooldown, and presses during it send nothing', () => {
  const t = clocks(), waits = new TabWaits(t.c);
  // 429 with Retry-After 300 on the first ask: the next could only go at 300 s, past the 90 s deadline.
  const first = drive(t, waits.attempt(), () => 300);
  assert.deepEqual(first.sends, [0]);
  assert.deepEqual(first.end, { kind: 'end', why: 'deadline', cooldownMs: 300 * S }, 'ends at once, saying when');
  t.mono = 100 * S; t.wall += 100 * S;
  const press = waits.attempt();
  assert.deepEqual(press.next(), { kind: 'end', why: 'cooldown', cooldownMs: 200 * S }, 'a press during it sends nothing and says how long');
  t.mono = 300 * S;
  assert.deepEqual(waits.attempt().next(), { kind: 'send' }, 'after it, a press asks');
  // A wait that ends exactly at the deadline is kept; one second more is not.
  const at = clocks(), w2 = new TabWaits(at.c), a2 = w2.attempt();
  a2.next(); a2.sent(); a2.answered(90);
  assert.deepEqual(a2.next(), { kind: 'wait', ms: ATTEMPT_MS });
  const bt = clocks(), w3 = new TabWaits(bt.c), a3 = w3.attempt();
  a3.next(); a3.sent(); a3.answered(91);
  assert.equal((a3.next() as { why?: string }).why, 'deadline');
  assert.equal(w3.cooldownLeft(), 91 * S);
  // The backoff pushing past the deadline makes no cooldown: a second ask at 88 s, whose next step (4 s) would be at 92 s.
  const ct = clocks(), w4 = new TabWaits(ct.c), a4 = w4.attempt();
  a4.next(); a4.sent(); a4.answered();
  ct.mono = 88 * S;
  assert.deepEqual(a4.next(), { kind: 'send' });
  a4.sent(); a4.answered();
  assert.deepEqual(a4.next(), { kind: 'end', why: 'deadline', cooldownMs: 0 });
  assert.equal(w4.cooldownLeft(), 0);
  // A sleep that overshoots the deadline (a throttled timer) does not send late.
  const dt = clocks(), a5 = new TabWaits(dt.c).attempt();
  a5.next(); a5.sent(); a5.answered(60);
  dt.mono = 95 * S;
  assert.equal((a5.next() as { why?: string }).why, 'deadline');
});

test('the monotonic clock standing still while the wall clock jumps ends the attempt (a suspended device)', () => {
  const t = clocks(), attempt = new TabWaits(t.c).attempt();
  assert.deepEqual(attempt.next(), { kind: 'send' });
  attempt.sent(); attempt.answered(3);
  assert.deepEqual(attempt.next(), { kind: 'wait', ms: 3 * S });
  t.wall += 3_600 * S;
  assert.deepEqual(attempt.next(), { kind: 'end', why: 'wall', cooldownMs: 0 });
  assert.equal(attempt.asks, 1);
  // Exactly at the guard it still runs; a wall clock set back never ends it.
  const u = clocks(), b = new TabWaits(u.c).attempt();
  b.next(); b.sent(); b.answered();
  u.wall += WALL_GUARD_MS;
  assert.equal(b.next().kind, 'wait');
  u.wall -= 10 * WALL_GUARD_MS;
  assert.equal(b.next().kind, 'wait');
  assert.throws(() => { const c = new TabWaits(u.c).attempt(); c.next(); c.sent(); c.next(); }, /in flight/, 'no step while an ask is in flight');
});

test('a request is given up after 20 s without AbortSignal.timeout; the timer and the listener go when it answers; a caller\'s signal aborts it', async () => {
  assert.equal(REQUEST_TIMEOUT_MS, 20_000);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let signal: AbortSignal | null = null;
    const never = withTimeout(s => { signal = s; return new Promise<never>((_, reject) => { s.addEventListener('abort', () => { reject(s.reason); }); }); });
    mock.timers.tick(REQUEST_TIMEOUT_MS - 1);
    assert.equal(signal!.aborted, false);
    mock.timers.tick(1);
    await assert.rejects(never, (e: unknown) => (e as DOMException).name === 'TimeoutError');

    // Answered in time: the timer is cleared (nothing aborts later) and the caller's listener is removed.
    const caller = new AbortController();
    let kept: AbortSignal | null = null;
    assert.equal(await withTimeout(async s => { kept = s; return 'answer'; }, caller.signal), 'answer');
    mock.timers.tick(REQUEST_TIMEOUT_MS * 2);
    caller.abort(new Error('closed later'));
    assert.equal(kept!.aborted, false, 'neither the timer nor the caller aborts a settled request');

    // The caller's signal aborts it before the timeout, with its reason; one already aborted aborts it at once.
    const form = new AbortController(), why = new Error('form closed');
    const pending = withTimeout(s => new Promise<never>((_, reject) => { s.addEventListener('abort', () => { reject(s.reason); }); }), form.signal);
    form.abort(why);
    await assert.rejects(pending, (e: unknown) => e === why);
    let early: AbortSignal | null = null;
    await withTimeout(async s => { early = s; }, AbortSignal.abort(why));
    assert.equal(early!.aborted, true);
    assert.equal(early!.reason, why);
  } finally { mock.timers.reset(); }
});
