/** Process memory is no longer admission-controlled; this keeps the narrow interface the feed and REST transports call. */
export interface ProcessMemoryReservation {
  admitted: boolean;
  reason?: string;
  release?(): number;
  resize?(bytes: number): ProcessMemoryReservation;
  requestedBytes?: number;
  projectedRssBytes?: number;
  hardLimitBytes?: number;
  reservedTransientBytes?: number;
}
export interface ProcessMemorySample { measured: boolean; rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number; arrayBuffersBytes: number }

const granted: ProcessMemoryReservation = { admitted: true, release: () => 0, resize: () => granted };

export class ProcessMemoryMonitor {
  /** Always granted. */
  reserveTransient(_bytes?: number, _context?: unknown): ProcessMemoryReservation { return granted; }
  sample(): ProcessMemorySample {
    const m = process.memoryUsage();
    return { measured: true, rssBytes: m.rss, heapUsedBytes: m.heapUsed, heapTotalBytes: m.heapTotal, externalBytes: m.external, arrayBuffersBytes: m.arrayBuffers };
  }
  snapshot(): ProcessMemorySample { return this.sample(); }
}

/** Names kept for the transport contracts that still pass reservation results around. */
export type ProcessMemoryDecision = ProcessMemoryReservation;
export type ProcessMemoryUsage = ProcessMemorySample;
