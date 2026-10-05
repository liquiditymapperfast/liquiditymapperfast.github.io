interface BookGroupingInput {
  resolution?: unknown;
  nSigFigs?: unknown;
  mantissa?: unknown;
}
interface NormalizedBookGrouping {
  resolution: 'native' | 'coarse';
  nSigFigs: number | null;
  mantissa: number | null;
}

/**
 * Stable identity for a market's order-book representation.
 *
 * One instrument can have a native book and one or more venue-grouped books.
 * Keeping the grouping in the key prevents a coarse snapshot from replacing
 * the native representation (or the two representations being added).
 */
export function normalizeBookGrouping({ resolution = 'native', nSigFigs = null, mantissa = null }: BookGroupingInput = {}): NormalizedBookGrouping {
  const normalizedResolution = String(resolution ?? 'native');
  const sig = nSigFigs == null || nSigFigs === '' ? null : Number(nSigFigs);
  const mant = mantissa == null || mantissa === '' ? null : Number(mantissa);
  if (normalizedResolution !== 'native' && normalizedResolution !== 'coarse') throw new RangeError(`Unsupported book resolution: ${normalizedResolution}`);
  if (sig != null && (!Number.isInteger(sig) || sig < 2 || sig > 5)) throw new RangeError('Book nSigFigs must be an integer from 2 to 5');
  if (mant != null && (!Number.isInteger(mant) || ![1, 2, 5].includes(mant))) throw new RangeError('Book mantissa must be one of 1, 2, or 5');
  if (mant != null && sig !== 5) throw new RangeError('Book mantissa is only valid when nSigFigs is 5');
  if (normalizedResolution === 'native' && (sig != null || mant != null)) throw new RangeError('Native book cannot carry grouping fields');
  if (normalizedResolution === 'coarse' && sig == null && mant == null) throw new RangeError('Coarse book requires nSigFigs or mantissa');
  return { resolution: normalizedResolution, nSigFigs: sig, mantissa: mant };
}

export function bookResolutionKey({ resolution = 'native', nSigFigs = null, mantissa = null }: BookGroupingInput = {}): string {
  const grouping = normalizeBookGrouping({ resolution, nSigFigs, mantissa });
  if (grouping.resolution === 'native') return 'native';
  return `sig:${grouping.nSigFigs}${grouping.mantissa == null ? '' : `:mant:${grouping.mantissa}`}`;
}

export function bookKey(instrumentId: unknown, resolutionKey: unknown = 'native'): string {
  const id = String(instrumentId ?? '').trim();
  const key = String(resolutionKey ?? '').trim();
  if (!id) throw new TypeError('Book instrumentId is required');
  if (!key) throw new TypeError('Book resolutionKey is required');
  return `${id}|${key}`;
}