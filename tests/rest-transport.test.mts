import type { RestRequest } from '../src/core/rest-retry.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import type { ProcessMemoryReservation } from '../src/server/process-memory.mts';
import { defined, fields, list, numeric, textValue, fieldMap, injectMapFixture, injectArrayFixture } from './server-test-helpers.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRestRequestCoordinator } from '../src/core/rest-retry.mts';
import { BoundedJsonResponseError, DEFAULT_BOUNDED_JSON_RESPONSE_BYTES, DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS, readBoundedJsonResponse } from '../src/core/bounded-json-response.mts';
import { createExchangeRestTransport, EXCHANGE_REST_JSON_TOKEN_MEMORY_BYTES, EXCHANGE_REST_MEMORY_ADMISSION_WAITER_LOGICAL_BYTES, EXCHANGE_REST_RESPONSE_CHUNK_OVERHEAD_BYTES, EXCHANGE_REST_RESPONSE_MEMORY_MULTIPLIER, MAX_EXCHANGE_REST_RESPONSE_BYTES, MAX_EXCHANGE_REST_CATALOG_RESPONSE_BYTES } from '../src/server/rest-transport.mts';
import { ProcessMemoryMonitor } from '../src/server/process-memory.mts';
import { buildWhitebitRequest } from '../src/adapters/whitebit.mts';
import { buildBitfinexRequest } from '../src/adapters/bitfinex.mts';
import { buildKrakenRequest } from '../src/adapters/kraken.mts';
import { buildAsterRequest } from '../src/adapters/aster.mts';
import { buildDydxRequest } from '../src/adapters/dydx.mts';
import { buildHyperliquidInfoRequest } from '../src/adapters/hyperliquid.mts';
import { buildPhemexRequest } from '../src/adapters/phemex.mts';
import { buildBitstampRequest } from '../src/adapters/bitstamp.mts';
import { buildCryptocomRequest } from '../src/adapters/cryptocom.mts';

function streamResponse(chunks: Uint8Array[], { headers = {}, status = 200 }: { headers?: HeadersInit; status?: number } = {}) {
  let index = 0;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) defined(controller).enqueue(chunks[index++]);
      else defined(controller).close();
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers, status }), canceled: () => canceled, chunksRead: () => index };
}

test('exchange REST transport returns bounded JSON and preserves the request envelope', async () => {
  let seen: { url: string; options: RequestInit } | undefined;
  const transport = createExchangeRestTransport({
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return new Response(JSON.stringify({ code: '0', data: [{ value: 3 }] }), { headers: { 'content-type': 'application/json' } });
    },
    timeoutMs: 2_000,
  });
  assert.deepEqual(await transport.request({ url: 'https://example.invalid/api', method: 'POST', headers: { accept: 'application/json' }, body: '{}' }), { code: '0', data: [{ value: 3 }] });
  assert.equal(defined(seen).url, 'https://example.invalid/api');
  assert.equal(defined(seen).options.method, 'POST');
  assert.equal(fields(defined(seen).options.headers).accept, 'application/json');
  assert.equal(defined(seen).options.body, '{}');
  assert.ok(defined(seen).options.signal instanceof AbortSignal);
  assert.equal(MAX_EXCHANGE_REST_RESPONSE_BYTES, DEFAULT_BOUNDED_JSON_RESPONSE_BYTES);
});

test('exchange REST transport cancels a declared oversized response before consuming it', async () => {
  const body = streamResponse([new TextEncoder().encode('{}')], {
    headers: { 'content-length': String(MAX_EXCHANGE_REST_RESPONSE_BYTES + 1) },
  });
  const transport = createExchangeRestTransport({ fetchImpl: async () => body.response });
  await assert.rejects(
    () => transport.request({ url: 'https://example.invalid/large' }),
    (error) => error instanceof BoundedJsonResponseError && error.code === 'BODY_TOO_LARGE' && error.retryable === false,
  );
  assert.equal(body.canceled(), true);
  assert.equal(body.chunksRead(), 0);
});

test('exchange REST transport enforces the cumulative streamed-byte limit across chunks', async () => {
  const body = streamResponse([
    new Uint8Array(MAX_EXCHANGE_REST_RESPONSE_BYTES),
    new Uint8Array(1),
    new Uint8Array(1),
  ]);
  const transport = createExchangeRestTransport({ fetchImpl: async () => body.response });
  await assert.rejects(
    () => transport.request({ url: 'https://example.invalid/chunked' }),
    (error) => error instanceof BoundedJsonResponseError && error.code === 'BODY_TOO_LARGE' && error.retryable === false,
  );
  assert.equal(body.canceled(), true);
  assert.equal(body.chunksRead(), 2, 'the reader stops at the first chunk that crosses the cap');
});

test('exchange REST response parse failures are fail-closed and non-retryable', async () => {
  for (const [bytes, code] of [
    [Uint8Array.from([0xff]), 'BODY_INVALID_UTF8'],
    [new TextEncoder().encode('{'), 'BODY_INVALID_JSON'],
  ]) {
    const transport = createExchangeRestTransport({ fetchImpl: async () => new Response(bytes) });
    await assert.rejects(
      () => transport.request({ url: 'https://example.invalid/malformed' }),
      (error) => error instanceof BoundedJsonResponseError && error.code === code && error.retryable === false,
    );
  }
});

test('exchange REST HTTP failures preserve status and retry-after while canceling their body', async () => {
  const body = streamResponse([new TextEncoder().encode('busy')], {
    headers: { 'retry-after': '2' },
    status: 503,
  });
  const transport = createExchangeRestTransport({ fetchImpl: async () => body.response });
  await assert.rejects(
    () => transport.request({ url: 'https://example.invalid/unavailable' }),
    (error) => fields(error).status === 503 && fields(error).retryable === true && fields(error).retryAfterMs === 2_000,
  );
  assert.equal(body.canceled(), true);
});

test('oversized exchange REST bodies do not consume the coordinator retry budget', async () => {
  let fetches = 0;
  let scheduledRetries = 0;
  const body = streamResponse([new Uint8Array(MAX_EXCHANGE_REST_RESPONSE_BYTES + 1)]);
  const transport = createExchangeRestTransport({
    fetchImpl: async () => { fetches += 1; return body.response; },
  });
  const coordinator = createRestRequestCoordinator({
    transport: (request) => transport.request(requestEnvelope(request)),
    policies: { default: { maxAttempts: 3, maxAttemptsPerWindow: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
    schedule: (callback) => { scheduledRetries += 1; callback(); },
    random: () => 0,
    now: () => 0,
  });
  await assert.rejects(
    () => coordinator.request({ url: 'https://example.invalid/large' }),
    (error) => error instanceof BoundedJsonResponseError && error.code === 'BODY_TOO_LARGE' && error.retryable === false,
  );
  assert.equal(fetches, 1);
  assert.equal(scheduledRetries, 0);
});

test('transient response reader failure retries and then succeeds', async () => {
  let fetches = 0;
  const transport = createExchangeRestTransport({ fetchImpl: async () => {
    fetches += 1;
    if (fetches === 1) {
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('stream interrupted')); } }));
    }
    return new Response('{"ok":true}');
  } });
  const coordinator = createRestRequestCoordinator({
    transport: (request) => transport.request(requestEnvelope(request)),
    policies: { default: { maxAttempts: 2, maxAttemptsPerWindow: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
    schedule: (callback) => { callback(); }, random: () => 0, now: () => 0,
  });
  assert.deepEqual(await coordinator.request({ url: 'https://example.invalid/interrupted' }), { ok: true });
  assert.equal(fetches, 2);
});

test('unfiltered catalog builders select a finite larger cap while bounded routes retain the default', async () => {
  const catalogs = [
    buildWhitebitRequest('markets'), buildBitfinexRequest('symbolsDetails'),
    buildKrakenRequest('assetPairs'), buildAsterRequest('exchangeInfo'),
    buildDydxRequest('perpetualMarkets'), buildHyperliquidInfoRequest('metaAndAssetCtxs'),
    buildHyperliquidInfoRequest('allMids'), buildPhemexRequest('products'),
    buildBitstampRequest('markets'), buildCryptocomRequest('instrument'),
  ];
  assert.ok(MAX_EXCHANGE_REST_CATALOG_RESPONSE_BYTES > MAX_EXCHANGE_REST_RESPONSE_BYTES);
  for (const request of catalogs) assert.equal(request.responseClass, 'catalog', request.url);
  assert.equal(buildHyperliquidInfoRequest('l2Book', { coin: 'BTC' }).responseClass, undefined);

  const betweenCaps = new TextEncoder().encode(' '.repeat(MAX_EXCHANGE_REST_RESPONSE_BYTES) + '{}');
  const transport = createExchangeRestTransport({ fetchImpl: async () => new Response(betweenCaps) });
  assert.deepEqual(await transport.request(catalogs[0]), {});
  await assert.rejects(() => transport.request({ url: 'https://example.invalid/depth' }),
    (error) => fields(error).code === 'BODY_TOO_LARGE' && fields(error).retryable === false);

  const tooLarge = streamResponse([new Uint8Array(1)], { headers: { 'content-length': String(MAX_EXCHANGE_REST_CATALOG_RESPONSE_BYTES + 1) } });
  const capped = createExchangeRestTransport({ fetchImpl: async () => tooLarge.response });
  await assert.rejects(() => capped.request(catalogs[0]),
    (error) => fields(error).code === 'BODY_TOO_LARGE' && fields(error).retryable === false);
  assert.equal(tooLarge.canceled(), true);
});

test('exchange REST reader decodes UTF-8 that spans response chunks', async () => {
  const body = streamResponse([
    new TextEncoder().encode('{"name":"'),
    Uint8Array.of(0xe2),
    Uint8Array.of(0x82, 0xac),
    new TextEncoder().encode('"}'),
  ]);
  const transport = createExchangeRestTransport({ fetchImpl: async () => body.response });
  assert.deepEqual(await transport.request({ url: 'https://example.invalid/utf8-split' }), { name: '€' });
});

test('exchange REST response reader caps fragmented streams before parsing', async () => {
  const maxChunks = 8_192;
  const body = streamResponse(Array.from({ length: maxChunks + 1 }, () => Uint8Array.of(0x20)));
  const transport = createExchangeRestTransport({ fetchImpl: async () => body.response });
  await assert.rejects(
    () => transport.request({ url: 'https://example.invalid/fragmented' }),
    (error) => error instanceof BoundedJsonResponseError && error.code === 'BODY_TOO_FRAGMENTED' && error.retryable === false,
  );
  assert.equal(body.canceled(), true);
  assert.equal(body.chunksRead(), maxChunks + 1);
});

test('bounded JSON parser rejects excessive token count or nesting before parse admission', async () => {
  let beforeParse: unknown = null;
  const bodyText = '{"text":"braces { [ and an escaped quote \\" stay inside a string","rows":[{"value":1}]}';
  const response = new Response(bodyText);
  const parsed = await readBoundedJsonResponse(response, {
    maxBytes: 1_024,
    maxJsonTokens: 9,
    maxJsonDepth: 4,
    onBeforeParse: (measurement) => { beforeParse = measurement; },
  });
  assert.deepEqual(parsed, { text: 'braces { [ and an escaped quote " stay inside a string', rows: [{ value: 1 }] });
  assert.deepEqual(beforeParse, { bodyBytes: Buffer.byteLength(bodyText), textLength: bodyText.length, textPartCount: 1, jsonTokens: 8, jsonDepth: 3 });

  await assert.rejects(
    () => readBoundedJsonResponse(new Response('[0,0,0]'), { maxBytes: 1_024, maxJsonTokens: 3 }),
    (error) => error instanceof BoundedJsonResponseError && error.code === 'BODY_TOO_COMPLEX' && error.limit === 'tokens',
  );
  await assert.rejects(
    () => readBoundedJsonResponse(new Response('[[[0]]]'), { maxBytes: 1_024, maxJsonDepth: 2 }),
    (error) => error instanceof BoundedJsonResponseError && error.code === 'BODY_TOO_COMPLEX' && error.limit === 'depth',
  );
});

function requestEnvelope(request: RestRequest): ExchangeRestRequest {
  const headers = request.headers == null ? undefined : Object.fromEntries(Object.entries(fields(request.headers)).map(([key, value]) => [key, textValue(value)]));
  return { url: textValue(request.url), ...(request.method == null ? {} : { method: textValue(request.method) }), ...(headers == null ? {} : { headers }), ...(request.body == null ? {} : { body: textValue(request.body) }), ...(request.responseClass == null ? {} : { responseClass: textValue(request.responseClass) }) };
}
