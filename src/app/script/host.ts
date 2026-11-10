import type { BarInputs } from './inputs.ts';
import { transferables } from './inputs.ts';
import type { RunResponse, ScriptJob, ScriptResult, WorkerMessage } from './protocol.ts';
import type { DepthMessage, DepthTag } from './depth.ts';
import { FULL_RUN_MS } from './lang/analysis.ts';

/**
 * The page's side of the script worker: one run at a time, the newest request waiting behind it (an older waiting one is dropped, its answer
 * would be stale), and a deadline. A script that loops is stopped by its own step budget inside the worker; a run that still does not answer
 * in time (a script that fills memory, a worker that hung) has its worker ended and a fresh one started, and every script of it is reported
 * as stopped. A fresh worker says when it has loaded; a run's clock starts only then, and a worker that does not load in `loadMs` is given up
 * on the same way. Loading can wait a long time on a page whose own requests hold every connection to its server (each address gets only a
 * few), so it has minutes, and its wait is not counted in the run's time (`RunOutcome.ms`). The worker never sees the page: it gets the inputs and the scripts' texts, and answers with what to draw.
 */

/** What the host needs of a worker (a real `Worker`, or a test's stand-in). */
export interface WorkerLike {
  postMessage(message: WorkerMessage, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: RunResponse }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface HostOptions {
  spawn: () => WorkerLike;
  /**
   * How long a run may take before its worker is ended (ms), and how much longer for each script after the first (each has its own time inside
   * the worker). By default each script has the time of a run from the first candle (`FULL_RUN_MS`; a live update stops itself sooner), the
   * first 1.5 s more for the messages and the worker's own work, each after it 0.1 s.
   */
  deadlineMs?: number;
  perScriptMs?: number;
  /** How long a fresh worker may take to load (ms). */
  loadMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  now?: () => number;
}

/**
 * A run's answer: one result per script, and how long it ran in its worker (ms), from when the worker took it to its answer or its deadline
 * (0 for one that never started). `depthBehind`: the worker did not hold the depth the run was told of (`RunResponse`).
 */
export interface RunOutcome { results: ScriptResult[]; ms: number; depthBehind?: boolean }
const NOTHING: RunOutcome = { results: [], ms: 0 };

interface Run { seq: number; jobs: ScriptJob[]; inputs: BarInputs; depth: DepthTag | undefined; timer: unknown; resolve: (r: RunOutcome) => void; sent: boolean; sentAt: number }

export class ScriptHost {
  #worker: WorkerLike | null = null;
  #ready = false;
  #seq = 0;
  #running: Run | null = null;
  #waiting: { jobs: ScriptJob[]; inputs: BarInputs; depth: DepthTag | undefined; resolve: (r: RunOutcome) => void } | null = null;
  /** Counts the workers started: one started since the page last sent the depth holds none of it (`post`). */
  #generation = 0;
  readonly #o: Required<HostOptions>;
  /** How many workers were ended for running over their deadline (or for not loading). */
  restarts = 0;

  constructor(o: HostOptions) {
    this.#o = { deadlineMs: FULL_RUN_MS + 1_500, perScriptMs: FULL_RUN_MS + 100, loadMs: 120_000, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: id => clearTimeout(id as ReturnType<typeof setTimeout>), now: () => Date.now(), ...o };
  }

  /**
   * Which worker is the current one (each started counts one): a page that sent depth to an earlier one sends it again. None (-1) while there
   * is none: the next post starts one, which holds nothing yet, so what is posted then must be everything.
   */
  get generation(): number { return this.#worker ? this.#generation : -1; }

  /**
   * Post the depth's change to the worker now, starting one if there is none: messages to one worker arrive in order, so a run asked for after
   * this reads it. Not a run: it is never dropped for a newer one. `transfer`: buffers only this message holds, handed over, not copied.
   */
  post(message: DepthMessage, transfer: ArrayBuffer[] = []): void { try { this.#ensure().postMessage(message, transfer); } catch { /* the next run reports a worker that fails */ } }

  /** Whether a run is under way (asked for, its worker loading or running it). */
  get busy(): boolean { return this.#running !== null; }
  /** Whether the run under way still waits for its worker to load: a newer request replaces it rather than waiting behind it. */
  get loading(): boolean { return this.#running !== null && !this.#running.sent; }

  /**
   * Run `jobs` over `inputs` (the arrays are handed over: do not use them after). Resolves with one result per job and the run's time; a request
   * overtaken by a newer one before its worker took it resolves with none. A run waiting for its worker to load is replaced the same way: the
   * worker then runs only the newest scripts, not ones changed or switched off meanwhile.
   */
  run(jobs: ScriptJob[], inputs: BarInputs, depth?: DepthTag): Promise<RunOutcome> {
    return new Promise(resolve => {
      const run = this.#running;
      if (run && !run.sent) { const was = run.resolve; run.jobs = jobs; run.inputs = inputs; run.depth = depth; run.resolve = resolve; was(NOTHING); return; }
      if (run) { this.#waiting?.resolve(NOTHING); this.#waiting = { jobs, inputs, depth, resolve }; return; }
      this.#start(jobs, inputs, depth, resolve);
    });
  }

  /**
   * Start loading a worker now, before any run is asked for: a page that will run scripts calls it as it starts, before its own requests take
   * every connection to its server and the worker's file would wait behind them.
   */
  warm(): void { try { this.#ensure(); } catch { /* the first run reports it */ } }

  /** Drop the run that waits for its worker to load (its scripts were switched off): it resolves with none, and the worker goes on loading. */
  dropUnsent(): void {
    const run = this.#running;
    if (!run || run.sent) return;
    if (run.timer !== null) this.#o.clearTimer(run.timer);
    this.#running = null;
    run.resolve(NOTHING);
  }

  #ensure(): WorkerLike {
    if (this.#worker) return this.#worker;
    const w = this.#o.spawn();
    this.#ready = false; this.#generation++;
    w.onmessage = e => { if (this.#worker !== w) return; if (e.data.t === 'ready') { this.#ready = true; this.#send(); } else this.#answer(e.data); };
    // A worker that fails to load or throws outside a run answers nothing: the run is ended as one over its deadline would be. One that
    // fails with nothing under way (its run was dropped while it loaded) is let go too, so the next run gets a fresh one and does not wait.
    w.onerror = () => {
      if (this.#worker !== w) return;
      if (this.#running) { this.#stop('worker-failed'); return; }
      w.terminate(); this.#worker = null; this.#ready = false;
    };
    return this.#worker = w;
  }

  #start(jobs: ScriptJob[], inputs: BarInputs, depth: DepthTag | undefined, resolve: (r: RunOutcome) => void): void {
    const run: Run = { seq: ++this.#seq, jobs, inputs, depth, timer: null, resolve, sent: false, sentAt: 0 };
    this.#running = run;
    try { this.#ensure(); } catch { this.#stop('worker-failed'); return; }
    if (this.#ready) this.#send();
    else run.timer = this.#o.setTimer(() => this.#stop('worker-failed'), this.#o.loadMs);
  }

  /** Hand the run under way to the worker, once it has loaded, and start its clock. */
  #send(): void {
    const run = this.#running;
    if (!run || run.sent || !this.#worker) return;
    if (run.timer !== null) this.#o.clearTimer(run.timer);
    run.sent = true; run.sentAt = this.#o.now();
    run.timer = this.#o.setTimer(() => this.#stop('timeout'), this.#o.deadlineMs + Math.max(0, run.jobs.length - 1) * this.#o.perScriptMs);
    try { this.#worker.postMessage({ t: 'run', seq: run.seq, jobs: run.jobs, inputs: run.inputs, ...(run.depth ? { depth: run.depth } : {}) }, transferables(run.inputs)); }
    catch { this.#stop('worker-failed'); }
  }

  #answer(msg: RunResponse): void {
    const run = this.#running;
    if (!run || msg.t !== 'result' || msg.seq !== run.seq) return;
    this.#o.clearTimer(run.timer);
    this.#running = null;
    const byId = new Map(msg.results.map(r => [r.id, r]));
    run.resolve({ results: run.jobs.map(j => byId.get(j.id) ?? { id: j.id, ok: false, error: { code: 'no-answer', line: 0, col: 0 } }), ms: this.#o.now() - run.sentAt, ...(msg.depthBehind ? { depthBehind: true } : {}) });
    this.#next();
  }

  /** End the worker of the run under way: every script of it is reported stopped, and the next run gets a fresh worker. */
  #stop(code: 'timeout' | 'worker-failed'): void {
    const run = this.#running; if (!run) return;
    if (run.timer !== null) this.#o.clearTimer(run.timer);
    this.#running = null;
    this.#worker?.terminate(); this.#worker = null; this.#ready = false; this.restarts++;
    run.resolve({ results: run.jobs.map(j => ({ id: j.id, ok: false, error: { code, line: 0, col: 0 } })), ms: run.sent ? this.#o.now() - run.sentAt : 0 });
    this.#next();
  }

  #next(): void {
    const w = this.#waiting; if (!w) return;
    this.#waiting = null;
    this.#start(w.jobs, w.inputs, w.depth, w.resolve);
  }

  /** End the worker and drop what waits (the page is closing the feature). */
  dispose(): void {
    if (this.#running) { if (this.#running.timer !== null) this.#o.clearTimer(this.#running.timer); this.#running.resolve(NOTHING); this.#running = null; }
    this.#waiting?.resolve(NOTHING); this.#waiting = null;
    this.#worker?.terminate(); this.#worker = null; this.#ready = false;
  }
}
