export interface BoundedJsonResponseErrorOptions {
  cause?: unknown;
  retryable?: boolean;
}

/** Reader protocol; each response chunk remains untrusted until its byte check. */
export interface BoundedJsonResponseReader {
  read(): { done?: unknown; value?: unknown } | PromiseLike<{ done?: unknown; value?: unknown }>;
  cancel(): unknown;
  releaseLock(): unknown;
}

export interface BoundedJsonResponse {
  body?: { getReader?(): BoundedJsonResponseReader | null | undefined } | null;
  headers?: { get?(name: string): unknown } | null;
}

export interface BoundedJsonComplexityOptions {
  maxTokens?: unknown;
  maxDepth?: unknown;
  label?: unknown;
}

export interface BoundedJsonComplexity {
  tokens: number;
  maxDepth: number;
}

export interface BoundedJsonParseMeasurement {
  bodyBytes: number;
  textLength: number;
  textPartCount: number;
  jsonTokens: number;
  jsonDepth: number;
}

export interface BoundedJsonResponseOptions {
  maxBytes?: unknown;
  maxChunks?: unknown;
  maxJsonTokens?: unknown;
  maxJsonDepth?: unknown;
  onBeforeParse?: ((measurement: BoundedJsonParseMeasurement) => unknown) | null;
  label?: string;
}

export const DEFAULT_BOUNDED_JSON_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS = 8_192;
export const DEFAULT_BOUNDED_JSON_RESPONSE_TOKENS = 1_000_000;
export const DEFAULT_BOUNDED_JSON_RESPONSE_DEPTH = 64;
export const DEFAULT_BOUNDED_JSON_TOKEN_MEMORY_BYTES = 96;
// Estimated allowance for each retained decoded string plus its textParts array slot.
export const DEFAULT_BOUNDED_JSON_RESPONSE_CHUNK_OVERHEAD_BYTES = 64;

export class BoundedJsonResponseError extends Error {
  declare code: string;
  declare retryable: boolean;
  declare limit?: 'depth' | 'tokens';

  constructor(message: string, code: string, { cause, retryable = false }: BoundedJsonResponseErrorOptions = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BoundedJsonResponseError';
    this.code = code;
    this.retryable = retryable;
  }
}

async function cancelReader(reader: BoundedJsonResponseReader): Promise<void> {
  try { await reader.cancel(); } catch { /* keep the original response error */ }
}

function jsonComplexity(text: string, { maxTokens, maxDepth, label }: { maxTokens: number; maxDepth: number; label: string }): BoundedJsonComplexity {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let maximumDepth = 0;
  let tokens = 0;
  let previous = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      tokens += 1;
      inString = true;
    } else if (character === '{' || character === '[') {
      depth += 1;
      maximumDepth = Math.max(maximumDepth, depth);
      tokens += 1;
      if (depth > maxDepth) {
        const error = new BoundedJsonResponseError(label + ' response exceeds ' + maxDepth + ' nested JSON levels', 'BODY_TOO_COMPLEX');
        error.limit = 'depth';
        throw error;
      }
    } else if (character === '}' || character === ']') {
      depth = Math.max(0, depth - 1);
    } else if ((character === '-' || (character >= '0' && character <= '9') || character === 't' || character === 'f' || character === 'n')
      && (previous === '' || previous === '[' || previous === ',' || previous === ':')) {
      tokens += 1;
    }
    if (tokens > maxTokens) {
      const error = new BoundedJsonResponseError(label + ' response exceeds ' + maxTokens + ' JSON tokens', 'BODY_TOO_COMPLEX');
      error.limit = 'tokens';
      throw error;
    }
    if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') previous = character;
  }
  return { tokens, maxDepth: maximumDepth };
}

export function scanBoundedJsonComplexity(text: unknown, {
  maxTokens = DEFAULT_BOUNDED_JSON_RESPONSE_TOKENS,
  maxDepth = DEFAULT_BOUNDED_JSON_RESPONSE_DEPTH,
  label = 'JSON',
}: BoundedJsonComplexityOptions = {}): BoundedJsonComplexity {
  if (typeof text !== 'string') throw new TypeError('JSON text must be a string');
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new RangeError('maxTokens must be a positive safe integer');
  if (typeof maxDepth !== 'number' || !Number.isSafeInteger(maxDepth) || maxDepth <= 0) throw new RangeError('maxDepth must be a positive safe integer');
  return jsonComplexity(text, { maxTokens, maxDepth, label: String(label) });
}

/** Read and parse JSON while enforcing the decoded response-byte limit. */
export async function readBoundedJsonResponse(response: BoundedJsonResponse | null | undefined, {
  maxBytes,
  maxChunks = DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS,
  maxJsonTokens = DEFAULT_BOUNDED_JSON_RESPONSE_TOKENS,
  maxJsonDepth = DEFAULT_BOUNDED_JSON_RESPONSE_DEPTH,
  onBeforeParse = null,
  label = 'JSON',
}: BoundedJsonResponseOptions = {}): Promise<unknown> {
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be a positive safe integer');
  if (typeof maxChunks !== 'number' || !Number.isSafeInteger(maxChunks) || maxChunks <= 0) throw new RangeError('maxChunks must be a positive safe integer');
  if (typeof maxJsonTokens !== 'number' || !Number.isSafeInteger(maxJsonTokens) || maxJsonTokens <= 0) throw new RangeError('maxJsonTokens must be a positive safe integer');
  if (typeof maxJsonDepth !== 'number' || !Number.isSafeInteger(maxJsonDepth) || maxJsonDepth <= 0) throw new RangeError('maxJsonDepth must be a positive safe integer');
  if (onBeforeParse != null && typeof onBeforeParse !== 'function') throw new TypeError('onBeforeParse must be a function or null');
  const reader = response?.body?.getReader?.();
  if (!reader) throw new BoundedJsonResponseError(label + ' response body is not readable', 'BODY_UNREADABLE');

  try {
    const declaredLength = Number(response?.headers?.get?.('content-length'));
    if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
      await cancelReader(reader);
      throw new BoundedJsonResponseError(label + ' response exceeds ' + maxBytes + ' bytes', 'BODY_TOO_LARGE');
    }

    const decoder = new TextDecoder('utf-8', { fatal: true });
    const textParts: string[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || !Number.isSafeInteger(totalBytes + value.byteLength)) {
        throw new BoundedJsonResponseError(label + ' response body is invalid', 'BODY_INVALID');
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await cancelReader(reader);
        throw new BoundedJsonResponseError(label + ' response exceeds ' + maxBytes + ' bytes', 'BODY_TOO_LARGE');
      }
      if (textParts.length >= maxChunks) {
        await cancelReader(reader);
        throw new BoundedJsonResponseError(label + ' response exceeds ' + maxChunks + ' body chunks', 'BODY_TOO_FRAGMENTED');
      }
      try { textParts.push(decoder.decode(value, { stream: true })); }
      catch (cause) { throw new BoundedJsonResponseError(label + ' response is not valid UTF-8', 'BODY_INVALID_UTF8', { cause }); }
    }

    try {
      const tail = decoder.decode();
      if (tail) textParts.push(tail);
    }
    catch (cause) { throw new BoundedJsonResponseError(label + ' response is not valid UTF-8', 'BODY_INVALID_UTF8', { cause }); }
    const text = textParts.join('');
    const complexity = scanBoundedJsonComplexity(text, { maxTokens: maxJsonTokens, maxDepth: maxJsonDepth, label });
    await onBeforeParse?.({ bodyBytes: totalBytes, textLength: text.length, textPartCount: textParts.length, jsonTokens: complexity.tokens, jsonDepth: complexity.maxDepth });
    try { return JSON.parse(text); }
    catch (cause) { throw new BoundedJsonResponseError(label + ' response is not valid JSON', 'BODY_INVALID_JSON', { cause }); }
  } catch (error) {
    await cancelReader(reader);
    if (error instanceof BoundedJsonResponseError) throw error;
    throw new BoundedJsonResponseError(label + ' response body could not be read', 'BODY_READ_FAILED', { cause: error, retryable: true });
  } finally {
    try { reader.releaseLock(); } catch { /* a canceled stream may already release its reader */ }
  }
}
