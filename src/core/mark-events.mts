import type { NormalizedMarkFrame } from '../domain/contracts.ts';

export const MARK_CROSSING_LIMIT = 200;

interface RawMarkFields {
  markInstrumentId?: unknown;
  markPrice?: unknown;
  sessionId?: unknown;
  sequence?: unknown;
  crossingSequenceStart?: unknown;
  crossingSequenceEnd?: unknown;
  crossingsComplete?: unknown;
  crossingsOverflow?: unknown;
  [key: string]: unknown;
}

interface MarkEnvelopeFields {
  payload?: unknown;
  [key: string]: unknown;
}

interface CoalescedMarkPayload extends Record<string, unknown> {
  crossings: unknown[];
  crossingsComplete: boolean;
  crossingsOverflow: boolean;
  crossingSequenceStart: unknown;
  crossingSequenceEnd: unknown;
}

export interface CoalescedMarkEnvelope extends Record<string, unknown> {
  payload: CoalescedMarkPayload;
}

export function mergeMarkPayload(previous: unknown, next: unknown, limit: unknown = MARK_CROSSING_LIMIT): CoalescedMarkEnvelope {
  const previousEnvelope = previous as MarkEnvelopeFields | null | undefined;
  const nextEnvelope = next as MarkEnvelopeFields | null | undefined;
  const previousPayload = (previousEnvelope?.payload ?? {}) as RawMarkFields;
  const nextPayload = (nextEnvelope?.payload ?? {}) as RawMarkFields;
  const previousSession = String(previousPayload.sessionId ?? '');
  const nextSession = String(nextPayload.sessionId ?? '');
  const sameContinuity = Boolean(previousSession && nextSession && previousSession === nextSession)
    && String(previousPayload.markInstrumentId ?? '') === String(nextPayload.markInstrumentId ?? '');
  const prior = sameContinuity && previousPayload.crossingsComplete !== false && previousPayload.crossingsOverflow !== true
    ? (Array.isArray(previousPayload.crossings) ? previousPayload.crossings : [])
    : [];
  const current = Array.isArray(nextPayload.crossings) ? nextPayload.crossings : [];
  const byLevel = new Map<string, unknown>();
  for (const crossing of [...prior, ...current]) {
    const fields = crossing as { levelId?: unknown } | null | undefined;
    const id = String(fields?.levelId ?? '');
    if (id) byLevel.set(id, crossing);
  }
  const boundedLimit = Math.max(1, Math.trunc(Number(limit) || MARK_CROSSING_LIMIT));
  const overflow = (sameContinuity && previousPayload.crossingsComplete === false)
    || (sameContinuity && previousPayload.crossingsOverflow === true)
    || nextPayload.crossingsComplete === false
    || nextPayload.crossingsOverflow === true
    || byLevel.size > boundedLimit;
  const crossings = [...byLevel.values()].slice(-boundedLimit);
  const crossingSequenceStart = sameContinuity
    ? (previousPayload.crossingSequenceStart ?? previousPayload.sequence ?? nextPayload.sequence)
    : (nextPayload.crossingSequenceStart ?? nextPayload.sequence);
  return {
    ...(next as Record<string, unknown>),
    payload: {
      ...nextPayload,
      crossings,
      crossingsComplete: !overflow,
      crossingsOverflow: overflow,
      crossingSequenceStart,
      crossingSequenceEnd: nextPayload.sequence,
    },
  };
}
