export interface MockProviderProvenance {
  mock: true;
  source: 'hypertracker-mock';
  coverage: 'mock';
  generatedAt: number;
}
function fields(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Copy only the provider's validated development provenance into history. */
export function mockProviderProvenance(value: unknown): MockProviderProvenance | null {
  const row = fields(value);
  if (row.mock !== true || row.source !== 'hypertracker-mock' || row.coverage !== 'mock'
    || typeof row.generatedAt !== 'number' || !Number.isSafeInteger(row.generatedAt) || row.generatedAt <= 0) return null;
  return { mock: true, source: 'hypertracker-mock', coverage: 'mock', generatedAt: row.generatedAt };
}
/** A startup-only demo anchor; once an observed mark exists it is required. */
export function createMockReferencePrice(readState: () => unknown, demoReferencePrice = 77_300): () => number {
  if (!Number.isFinite(demoReferencePrice) || demoReferencePrice <= 0) throw new RangeError('Invalid mock demo reference price');
  let markObserved = false;
  return () => {
    const state = fields(readState());
    const price = state.markPrice;
    if (state.markObserved === true && typeof price === 'number' && Number.isFinite(price) && price > 0) {
      markObserved = true;
      return price;
    }
    return markObserved ? Number.NaN : demoReferencePrice;
  };
}
