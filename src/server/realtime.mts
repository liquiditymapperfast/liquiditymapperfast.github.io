import { logicalRetainedBytes } from '../core/retained-bytes.mts';

export interface StreamFrame { event: string; payload: unknown; }
type ReplaceKind = 'priority' | 'liquidity';
interface QueueOptions<F> {
  write: (frame: F) => boolean | void;
  waitForDrain: (resume: () => void) => (() => void) | void;
  onWrite?: (frame: F, writable: boolean | void) => void;
  onReplace?: (previous: F, next: F, kind?: ReplaceKind) => void;
  onDrainWait?: () => void;
  onError?: (error: unknown, frame?: F) => void;
}
export class LocalEventBus<F = StreamFrame> {
  #listeners = new Set<(event: F) => void>();
  publish(event: F) { for (const listener of this.#listeners) listener(event); }
  subscribe(listener: (event: F) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
}

/**
 * Bounded latest-only slots for state, marks, and complete live book graphs.
 *
 * Feed reducers publish after each accepted message, but a slow browser must
 * never make the server retain a frame backlog. The reducer owns the complete
 * sequence; this queue only coalesces obsolete UI frames while a writable
 * transport is waiting for drain.
 */
export class LatestOnlyFrameQueue<F extends { payload?: unknown } = StreamFrame> {
  #write: QueueOptions<F>['write'];
  #waitForDrain: QueueOptions<F>['waitForDrain'];
  #onWrite: NonNullable<QueueOptions<F>['onWrite']>;
  #onReplace: NonNullable<QueueOptions<F>['onReplace']>;
  #onDrainWait: NonNullable<QueueOptions<F>['onDrainWait']>;
  #onError: NonNullable<QueueOptions<F>['onError']>;
  #pending: F | null = null;
  #priorityPending: F | null = null;
  #liquidityPending: F | null = null;
  #waiting = false;
  #closed = false;
  #cancelDrain: (() => void) | null = null;
  #sent = 0;
  #replacements = 0;
  #drainWaits = 0;
  #transportBufferedLogicalBytes = 0;
  #maxPending = 0;
  #maxPendingSlots = 0;

  #recordPendingSlots() {
    this.#maxPendingSlots = Math.max(this.#maxPendingSlots, Number(this.#pending !== null) + Number(this.#priorityPending !== null) + Number(this.#liquidityPending !== null));
  }

  constructor({ write, waitForDrain, onWrite = () => {}, onReplace = () => {}, onDrainWait = () => {}, onError = () => {} }: QueueOptions<F>) {
    if (typeof write !== 'function') throw new TypeError('latest-only queue requires a write function');
    if (typeof waitForDrain !== 'function') throw new TypeError('latest-only queue requires a drain waiter');
    this.#write = write;
    this.#waitForDrain = waitForDrain;
    this.#onWrite = onWrite;
    this.#onReplace = onReplace;
    this.#onDrainWait = onDrainWait;
    this.#onError = onError;
  }

  enqueue(frame: F) {
    if (this.#closed) return false;
    if (this.#pending !== null) {
      this.#replacements += 1;
      this.#onReplace(this.#pending, frame);
    }
    this.#pending = frame;
    this.#maxPending = Math.max(this.#maxPending, 1);
    this.#recordPendingSlots();
    this.#flush();
    return true;
  }

  /** Queue a higher-priority frame (for example a mark update).
   *
   * It gets its own single replaceable slot, so a blocked state frame cannot
   * hide the latest mark. `merge` may carry bounded semantic events forward
   * when intermediate mark frames are coalesced.
   */
  enqueuePriority(frame: F, merge: ((previous: F, next: F) => F) | null = null) {
    if (this.#closed) return false;
    if (this.#priorityPending !== null) {
      const previous = this.#priorityPending;
      this.#priorityPending = typeof merge === 'function' ? merge(previous, frame) : frame;
      this.#replacements += 1;
      this.#onReplace(previous, this.#priorityPending, 'priority');
    } else {
      this.#priorityPending = frame;
    }
    this.#recordPendingSlots();
    this.#flush();
    return true;
  }

  /** A complete current book graph gets one replaceable slot, never a delta backlog. */
  enqueueLiquidity(frame: F) {
    if (this.#closed) return false;
    if (this.#liquidityPending !== null) {
      this.#replacements += 1;
      this.#onReplace(this.#liquidityPending, frame, 'liquidity');
    }
    this.#liquidityPending = frame;
    this.#recordPendingSlots();
    this.#flush();
    return true;
  }

  invalidatePending(predicate: (frame: F) => boolean = () => false) {
    if (this.#closed || typeof predicate !== 'function') return 0;
    let removed = 0;
    if (this.#pending !== null && predicate(this.#pending)) { this.#pending = null; removed += 1; }
    if (this.#priorityPending !== null && predicate(this.#priorityPending)) { this.#priorityPending = null; removed += 1; }
    if (this.#liquidityPending !== null && predicate(this.#liquidityPending)) { this.#liquidityPending = null; removed += 1; }
    this.#flush();
    return removed;
  }

  #flush() {
    while (!this.#closed && !this.#waiting && (this.#priorityPending !== null || this.#liquidityPending !== null || this.#pending !== null)) {
      const priority = this.#priorityPending !== null;
      const liquidity = !priority && this.#liquidityPending !== null;
      const frame = priority ? this.#priorityPending : liquidity ? this.#liquidityPending : this.#pending;
      if (frame === null) return;
      if (priority) this.#priorityPending = null;
      else if (liquidity) this.#liquidityPending = null;
      else this.#pending = null;
      let writable;
      try {
        writable = this.#write(frame);
      } catch (error) {
        this.close();
        this.#onError(error, frame);
        return;
      }
      this.#sent += 1;
      this.#onWrite(frame, writable);
      if (writable === false) {
        this.#waitForWritableDrain(logicalRetainedBytes(frame?.payload ?? null));
        return;
      }
    }
  }

  #waitForWritableDrain(transportBufferedLogicalBytes = 0) {
    if (this.#closed || this.#waiting) return;
    this.#transportBufferedLogicalBytes = transportBufferedLogicalBytes;
    this.#waiting = true;
    this.#drainWaits += 1;
    this.#onDrainWait();
    const resume = () => {
      if (this.#closed) return;
      this.#waiting = false;
      this.#transportBufferedLogicalBytes = 0;
      this.#cancelDrain = null;
      this.#flush();
    };
    try {
      this.#cancelDrain = this.#waitForDrain(resume) ?? null;
    } catch (error) {
      this.close();
      this.#onError(error);
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = null;
    this.#priorityPending = null;
    this.#liquidityPending = null;
    this.#transportBufferedLogicalBytes = 0;
    this.#waiting = false;
    if (typeof this.#cancelDrain === 'function') this.#cancelDrain();
    this.#cancelDrain = null;
  }

  get closed() { return this.#closed; }
  get waiting() { return this.#waiting; }
  get pending() { return this.#pending; }
  get liquidityPending() { return this.#liquidityPending; }
  get priorityPending() { return this.#priorityPending; }
  /** Scalar activity metrics only; byte admission must use fresh diagnostics. */
  get maxPending() { return this.#maxPending; }
  get maxPendingSlots() { return this.#maxPendingSlots; }
  diagnostics() {
    return {
      sent: this.#sent,
      replacements: this.#replacements,
      drainWaits: this.#drainWaits,
      maxPending: this.#maxPending,
      maxPendingSlots: this.#maxPendingSlots,
      pending: this.#pending !== null || this.#priorityPending !== null || this.#liquidityPending !== null,
      liquidityPending: this.#liquidityPending !== null,
      priorityPending: this.#priorityPending !== null,
      pendingSlots: Number(this.#pending !== null) + Number(this.#priorityPending !== null) + Number(this.#liquidityPending !== null),
      pendingLogicalBytes: logicalRetainedBytes([this.#pending?.payload ?? null, this.#priorityPending?.payload ?? null, this.#liquidityPending?.payload ?? null]) + this.#transportBufferedLogicalBytes,
      transportBufferedLogicalBytes: this.#transportBufferedLogicalBytes,
      waiting: this.#waiting,
      closed: this.#closed,
    };
  }
}
