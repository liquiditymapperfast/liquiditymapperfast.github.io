import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedJsonResponseError, readBoundedJsonResponse } from '../src/core/bounded-json-response.mts';

function trackedResponse(chunks: readonly unknown[], { readError = null, cleanupError = null }: { readError?: unknown; cleanupError?: unknown } = {}) {
  let index = 0;
  const counts = { canceled: 0, released: 0 };
  const reader = {
    async read() {
      if (readError) throw readError;
      return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true };
    },
    async cancel() {
      counts.canceled += 1;
      if (cleanupError) throw cleanupError;
    },
    releaseLock() {
      counts.released += 1;
      if (cleanupError) throw cleanupError;
    },
  };
  return { response: { body: { getReader: () => reader } }, counts };
}

test('bounded JSON remains stream-only and preserves reader acquisition errors', async () => {
  let textReads = 0;
  await assert.rejects(
    () => readBoundedJsonResponse(Object.assign({ body: null }, { text: async () => { textReads += 1; return '{}'; } }), { maxBytes: 64 }),
    (error: unknown) => error instanceof BoundedJsonResponseError && error.code === 'BODY_UNREADABLE' && error.retryable === false,
  );
  assert.equal(textReads, 0);

  const acquisitionError = new Error('reader is locked');
  await assert.rejects(
    () => readBoundedJsonResponse({ body: { getReader() { throw acquisitionError; } } }, { maxBytes: 64 }),
    (error: unknown) => error === acquisitionError,
  );
});

test('bounded JSON preserves body failures when cancellation and lock release both fail', async (t) => {
  const readError = new Error('reader interrupted');
  const cases: { name: string; chunks: unknown[]; code: string; readError?: Error }[] = [
    { name: 'invalid chunk', chunks: ['{}'], code: 'BODY_INVALID' },
    { name: 'invalid UTF-8', chunks: [Uint8Array.of(0xff)], code: 'BODY_INVALID_UTF8' },
    { name: 'incomplete UTF-8 tail', chunks: [Uint8Array.of(0xe2)], code: 'BODY_INVALID_UTF8' },
    { name: 'invalid JSON', chunks: [new TextEncoder().encode('{')], code: 'BODY_INVALID_JSON' },
    { name: 'reader failure', chunks: [], code: 'BODY_READ_FAILED', readError },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const body = trackedResponse(entry.chunks, { readError: entry.readError, cleanupError: new Error('cleanup failed') });
      await assert.rejects(
        () => readBoundedJsonResponse(body.response, { maxBytes: 64 }),
        (error: unknown) => {
          assert.ok(error instanceof BoundedJsonResponseError);
          assert.equal(error.code, entry.code);
          assert.equal(error.retryable, entry.code === 'BODY_READ_FAILED');
          if (entry.readError) assert.equal(error.cause, entry.readError);
          return true;
        },
      );
      assert.deepEqual(body.counts, { canceled: 1, released: 1 });
    });
  }
});

test('bounded JSON awaits parse admission and preserves admission rejection', async () => {
  const body = trackedResponse([new TextEncoder().encode('null')]);
  const events: string[] = [];
  const value = await readBoundedJsonResponse(body.response, {
    maxBytes: 64,
    async onBeforeParse(measurement) {
      assert.deepEqual(measurement, { bodyBytes: 4, textLength: 4, textPartCount: 1, jsonTokens: 1, jsonDepth: 0 });
      events.push('admission started');
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push('admission complete');
    },
  }).then((parsed) => { events.push('returned'); return parsed; });
  assert.equal(value, null);
  assert.deepEqual(events, ['admission started', 'admission complete', 'returned']);
  assert.deepEqual(body.counts, { canceled: 0, released: 1 });

  const rejectedBody = trackedResponse([new TextEncoder().encode('{}')], { cleanupError: new Error('cleanup failed') });
  const admissionError = new BoundedJsonResponseError('parse reservation rejected', 'PROCESS_MEMORY_LIMIT');
  await assert.rejects(
    () => readBoundedJsonResponse(rejectedBody.response, {
      maxBytes: 64,
      async onBeforeParse() { throw admissionError; },
    }),
    (error: unknown) => error === admissionError,
  );
  assert.deepEqual(rejectedBody.counts, { canceled: 1, released: 1 });
});

test('TypeScript emission preserves the optional bounded error property shape', () => {
  const error = new BoundedJsonResponseError('body invalid', 'BODY_INVALID');
  assert.deepEqual(Object.keys(error), ['name', 'code', 'retryable']);
  assert.equal(Object.hasOwn(error, 'limit'), false);
  assert.equal(Object.hasOwn(error, 'cause'), false);

  const cause = new Error('invalid byte');
  const caused = new BoundedJsonResponseError('body invalid', 'BODY_INVALID', { cause });
  assert.equal(caused.cause, cause);
  assert.equal(Object.prototype.propertyIsEnumerable.call(caused, 'cause'), false);
});
