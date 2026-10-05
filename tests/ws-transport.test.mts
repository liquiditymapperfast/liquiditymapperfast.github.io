import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createWsTransport, MAX_LIVE_FEED_MESSAGE_BYTES } from '../src/server/live-feeds.mts';

import type { WebSocket } from 'ws';
import { defined, fields, textValue, numeric } from './server-test-helpers.mts';

const MAX_FEED_MESSAGE_BYTES = MAX_LIVE_FEED_MESSAGE_BYTES;

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' timed out')), 5_000);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

test('production websocket transport accepts the limit and rejects oversized plain and compressed messages', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
  const peers = new Set<WebSocket>();
  server.on('connection', peer => {
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('message', data => {
      const command = Buffer.isBuffer(data) ? data.toString() : String(data);
      if (command === 'exact') peer.send(Buffer.alloc(MAX_FEED_MESSAGE_BYTES), { binary: true, compress: false });
      if (command === 'oversized') peer.send(Buffer.alloc(MAX_FEED_MESSAGE_BYTES + 1), { binary: true, compress: false });
      if (command === 'compressed-oversized') peer.send(Buffer.alloc(MAX_FEED_MESSAGE_BYTES + 1, 0x78), { binary: true, compress: true });
    });
  });

  const transports: Awaited<ReturnType<typeof createWsTransport>>[] = [];
  try {
    assert.equal(MAX_FEED_MESSAGE_BYTES, 1_048_576);
    await within(new Promise<void>(resolve => server.once('listening', resolve)), 'websocket server startup');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    const first = await createWsTransport({ request: { url: 'ws://127.0.0.1:' + port } });
    transports.push(first);
    const firstErrors: unknown[] = [];
    first.on('error', error => firstErrors.push(error));
    const exactMessage = new Promise<unknown>(resolve => first.on('message', resolve));
    await first.open();
    first.send('exact');
    const accepted = await within(exactMessage, 'exact-limit message');
    assert.equal(numeric(fields(accepted).byteLength), MAX_FEED_MESSAGE_BYTES);
    assert.deepEqual(firstErrors, []);

    let firstMessageCount = 1;
    first.on('message', () => { firstMessageCount += 1; });
    const plainClose = new Promise(resolve => first.on('close', code => resolve(code)));
    first.send('oversized');
    const plainCode = await within(plainClose, 'oversized plain-message close');
    assert.ok(plainCode === 1006 || plainCode === 1009);
    assert.equal(fields(defined(firstErrors[0])).code, 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
    assert.match(textValue(fields(defined(firstErrors[0])).message), /Max payload size exceeded/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(firstMessageCount, 1);

    const second = await createWsTransport({ request: { url: 'ws://127.0.0.1:' + port } });
    transports.push(second);
    const secondErrors: unknown[] = [];
    second.on('error', error => secondErrors.push(error));
    const secondMessages: unknown[] = [];
    second.on('message', data => secondMessages.push(data));
    const compressedClose = new Promise<unknown>(resolve => second.on('close', code => resolve(code)));
    await second.open();
    second.send('compressed-oversized');
    const compressedCode = await within(compressedClose, 'oversized compressed-message close');
    assert.ok(compressedCode === 1006 || compressedCode === 1009);
    assert.equal(fields(defined(secondErrors[0])).code, 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
    assert.match(textValue(fields(defined(secondErrors[0])).message), /Max payload size exceeded/);
    assert.deepEqual(secondMessages, []);
  } finally {
    for (const transport of transports) {
      try { transport.close(); } catch {}
    }
    for (const peer of peers) peer.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
