const STABLE_QUOTES: ReadonlySet<string> = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI']);
type BookSide = 'bid' | 'ask';
type ConversionSource = 'metadata' | 'stable-quote';
interface BookMarketInput {
  quantityUnit?: unknown;
  contractValue?: unknown;
  quoteToUsd?: unknown;
  quoteUsdRate?: unknown;
  quote?: unknown;
  contractType?: unknown;
  inverse?: unknown;
  [key: string]: unknown;
}
interface BookValuationInput {
  market?: BookMarketInput | null;
  units?: unknown;
  contractValue?: unknown;
  quoteToUsd?: unknown;
  quoteUsdRate?: unknown;
  quote?: unknown;
  contractType?: unknown;
  inverse?: unknown;
  bids?: readonly unknown[] | null;
  asks?: readonly unknown[] | null;
  levelMetadata?: unknown;
  [key: string]: unknown;
}
interface QuoteConversion { rate: number; source: ConversionSource }
interface BookRowValues { price: unknown; amount: unknown; suppliedNotional: unknown }
interface ValuationProvenance {
  units: string;
  contractType: string | null;
  quote: string | null;
  quoteToUsd: number | null;
  source: 'source-notional' | ConversionSource | null;
}
interface UsdBookLevel {
  price: number;
  amount: number;
  baseAmount: number;
  quoteAmount: number;
  side: BookSide;
  notionalUsd: number;
  notionalEstimated: boolean;
  valuation: ValuationProvenance;
  contractAmount?: number;
  [key: string]: unknown;
}

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function quoteConversion(book: BookValuationInput | null | undefined, market: BookMarketInput): QuoteConversion | null {
  const explicit = finitePositive(book?.quoteToUsd ?? book?.quoteUsdRate ?? market?.quoteToUsd ?? market?.quoteUsdRate);
  if (explicit != null) return { rate: explicit, source: 'metadata' };
  const quote = String(book?.quote ?? market?.quote ?? '').trim().toUpperCase();
  if (STABLE_QUOTES.has(quote)) return { rate: 1, source: 'stable-quote' };
  return null;
}

function rowValues(row: unknown): BookRowValues {
  if (Array.isArray(row)) {
    const tuple = row as readonly unknown[];
    return { price: tuple[0], amount: tuple[1], suppliedNotional: tuple[2] };
  }
  const object = row as { price?: unknown; amount?: unknown; size?: unknown; qty?: unknown; notionalUsd?: unknown } | null | undefined;
  return { price: object?.price, amount: object?.amount ?? object?.size ?? object?.qty, suppliedNotional: object?.notionalUsd };
}

/**
 * USD per quote unit when a book is quoted in base size and a USD conversion is known: the common case, where a level's notional is just
 * price x amount x rate and nothing else about the row matters. Null means use `usdBookLevels`, which handles contracts, quote-sized books,
 * supplied notionals and everything unusual.
 */
export function baseSizeUsdRate(book: BookValuationInput | null | undefined, market: BookMarketInput | null = null): number | null {
  const sourceMarket: BookMarketInput = { ...(market || {}), ...(book?.market || {}) };
  const units = String(book?.units ?? sourceMarket.quantityUnit ?? 'base').trim().toLowerCase();
  if (units !== 'base') return null;
  return quoteConversion(book, sourceMarket)?.rate ?? null;
}

/**
 * Convert a retained venue book into USD-valued rows.
 * `amount` is always normalized base size; original quote/contract amounts
 * and valuation provenance remain attached for downstream renderers.
 */
export function usdBookLevels(book: BookValuationInput | null | undefined, market: BookMarketInput | null = null): UsdBookLevel[] {
  const sourceMarket: BookMarketInput = { ...(market || {}), ...(book?.market || {}) };
  const units = String(book?.units ?? sourceMarket.quantityUnit ?? 'base').trim().toLowerCase();
  const contractValue = finitePositive(book?.contractValue ?? sourceMarket.contractValue);
  if (units === 'contract' && contractValue == null) return [];
  const contractSize = contractValue ?? 0;
  if (!['base', 'quote', 'contract'].includes(units)) return [];
  const conversion = quoteConversion(book, sourceMarket);
  const contractType = String(book?.contractType ?? sourceMarket.contractType ?? (book?.inverse || sourceMarket.inverse ? 'inverse' : 'linear')).toLowerCase();
  if (units === 'contract' && !['linear', 'inverse'].includes(contractType)) return [];
  const sides: ReadonlyArray<{ side: BookSide; rows: readonly unknown[] }> = [
    { side: 'bid', rows: book?.bids || [] },
    { side: 'ask', rows: book?.asks || [] },
  ];
  const out: UsdBookLevel[] = [];
  for (const { side, rows: sourceRows } of sides) {
    for (const row of sourceRows) {
      const tuple = Array.isArray(row) ? row as readonly unknown[] : null;
      const sideKey = side === 'bid' ? 'bids' : 'asks';
      const levelMetadata = book?.levelMetadata as { bids?: Record<string, unknown>; asks?: Record<string, unknown> } | null | undefined;
      const metadataValue = tuple ? levelMetadata?.[sideKey]?.[String(tuple[0])] : null;
      const metadata = metadataValue && typeof metadataValue === 'object' ? metadataValue as Record<string, unknown> : null;
      const sourceRow: unknown = metadata && tuple ? { ...metadata, price: tuple[0], amount: tuple[1] } : row;
      const values = rowValues(sourceRow);
      const price = finitePositive(values.price);
      const inputAmount = finitePositive(values.amount);
      if (price == null || inputAmount == null) continue;
      // `null`/empty notional means "not supplied". Number(null) is zero,
      // which would silently turn a missing valuation into an authoritative
      // zero and hide the quote conversion fallback.
      const suppliedRaw = values.suppliedNotional;
      const hasSupplied = suppliedRaw !== null && suppliedRaw !== undefined
        && !(typeof suppliedRaw === 'string' && suppliedRaw.trim() === '')
        && Number.isFinite(Number(suppliedRaw)) && Number(suppliedRaw) >= 0;
      const supplied = hasSupplied ? Number(suppliedRaw) : null;
      let baseAmount: number;
      let quoteAmount: number;
      let contractAmount: number | undefined;
      if (units === 'base') {
        baseAmount = inputAmount;
        quoteAmount = price * baseAmount;
      } else if (units === 'quote') {
        quoteAmount = inputAmount;
        baseAmount = quoteAmount / price;
      } else if (contractType === 'inverse') {
        contractAmount = inputAmount;
        quoteAmount = contractAmount * contractSize;
        baseAmount = quoteAmount / price;
      } else {
        contractAmount = inputAmount;
        baseAmount = contractAmount * contractSize;
        quoteAmount = price * baseAmount;
      }
      if (!(Number.isFinite(baseAmount) && baseAmount > 0 && Number.isFinite(quoteAmount) && quoteAmount >= 0)) continue;
      const notionalUsd = hasSupplied ? supplied : conversion ? quoteAmount * conversion.rate : null;
      if (notionalUsd == null || !(Number.isFinite(notionalUsd) && notionalUsd >= 0)) continue;
      const sourceRecord = sourceRow as Record<string, unknown> | null | undefined;
      const normalized: UsdBookLevel = {
        price,
        amount: baseAmount,
        baseAmount,
        quoteAmount,
        side,
        notionalUsd,
        notionalEstimated: hasSupplied ? sourceRecord?.notionalEstimated === true : true,
        valuation: {
          units,
          contractType: units === 'contract' ? contractType : null,
          quote: String(book?.quote ?? sourceMarket.quote ?? '').trim().toUpperCase() || null,
          quoteToUsd: conversion?.rate ?? null,
          source: hasSupplied ? 'source-notional' : conversion?.source ?? null,
        },
      };
      if (contractAmount != null) normalized.contractAmount = contractAmount;
      for (const key of ['priceLow', 'priceHigh', 'sourceGrouping', 'sourceGroupingBounds', 'sourceResolution', 'boundaryPrecision', 'boundarySemantics']) {
        if (sourceRecord && sourceRecord[key] !== undefined) normalized[key] = sourceRecord[key];
      }
      const sourceGroupingBounds = normalized.sourceGroupingBounds as { boundaryPrecision?: unknown; boundarySemantics?: unknown } | null | undefined;
      if (normalized.boundaryPrecision === undefined && sourceGroupingBounds?.boundaryPrecision !== undefined) normalized.boundaryPrecision = sourceGroupingBounds.boundaryPrecision;
      if (normalized.boundarySemantics === undefined && sourceGroupingBounds?.boundarySemantics !== undefined) normalized.boundarySemantics = sourceGroupingBounds.boundarySemantics;
      out.push(normalized);
    }
  }
  return out;
}