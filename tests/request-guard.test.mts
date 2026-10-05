import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { checkRequest, extraHostsFromEnv, guardRequest, guardUpgrade, hostnameOf } from '../src/server/request-guard.mts';

const req = (headers: Record<string, string>, method = 'GET') => ({ headers, method });

test('host names are read from the Host header without port or brackets', () => {
  assert.equal(hostnameOf('127.0.0.1:8787'), '127.0.0.1');
  assert.equal(hostnameOf('localhost:8787'), 'localhost');
  assert.equal(hostnameOf('[::1]:8787'), '::1');
  assert.equal(hostnameOf('Maps.Example.COM'), 'maps.example.com');
  assert.equal(hostnameOf(''), '');
  assert.deepEqual(extraHostsFromEnv(' Maps.Example.com:8443, other.example '), ['maps.example.com', 'other.example']);
  assert.deepEqual(extraHostsFromEnv(undefined), []);
});

test('the app itself, curl and a LAN address are allowed', () => {
  assert.equal(checkRequest(req({ host: '127.0.0.1:8787' })).ok, true, 'a program that sends no Origin');
  assert.equal(checkRequest(req({ host: 'localhost:8787', origin: 'http://localhost:8787', 'sec-fetch-site': 'same-origin' }, 'POST')).ok, true, 'the page posting to its own server');
  assert.equal(checkRequest(req({ host: '[::1]:8787', origin: 'http://[::1]:8787' }, 'POST')).ok, true);
  assert.equal(checkRequest(req({ host: '192.168.1.5:8787', origin: 'http://192.168.1.5:8787' }, 'POST')).ok, true, 'an IP address cannot be a rebound name');
  assert.equal(checkRequest(req({ host: 'dev.localhost:8787' })).ok, true);
  assert.equal(checkRequest(req({ host: '127.0.0.1:8787', 'sec-fetch-site': 'none' }, 'POST')).ok, true, 'typed into the address bar');
});

test('another website cannot drive or read the server through the browser', () => {
  const refused = (headers: Record<string, string>, method = 'GET') => { const verdict = checkRequest(req(headers, method)); return verdict.ok ? 'allowed' : verdict.reason; };
  assert.match(refused({ host: 'attacker.example:8787' }), /Host attacker.example is not allowed/, 'DNS rebinding: the page still carries its own host name');
  assert.equal(refused({}), 'allowed', 'a request with no Host at all (HTTP/1.0, hand-built) has nothing a rebound page could use');
  assert.equal(refused({ origin: 'http://127.0.0.1:8787' }, 'POST'), 'cross-origin request', 'but with an Origin it cannot be the same origin as a host it never named');
  assert.equal(refused({ host: '127.0.0.1:8787', origin: 'https://attacker.example' }, 'POST'), 'cross-origin request', 'a simple cross-site POST needs no preflight');
  assert.equal(refused({ host: '127.0.0.1:8787', origin: 'null' }, 'POST'), 'cross-origin request', 'sandboxed frames and files');
  assert.equal(refused({ host: 'localhost:8787', origin: 'http://localhost:3000' }, 'POST'), 'cross-origin request', 'another local app on another port is another origin');
  assert.equal(refused({ host: '127.0.0.1:8787', origin: 'http://localhost:8787' }), 'cross-origin request', 'the origin must be the very host the request names');
  assert.equal(refused({ host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }, 'POST'), 'cross-site request', 'a browser that sent no Origin still says where the request came from');
  assert.equal(refused({ host: '127.0.0.1:8787', 'sec-fetch-site': 'same-site' }, 'POST'), 'cross-site request');
  assert.equal(refused({ host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }), 'allowed', 'a plain read is harmless: without CORS headers the page never sees the answer');
});

test('a deployment lists its public name explicitly', () => {
  assert.equal(checkRequest(req({ host: 'maps.example.com', origin: 'https://maps.example.com' }, 'POST')).ok, false, 'not allowed by default');
  assert.equal(checkRequest(req({ host: 'maps.example.com', origin: 'https://maps.example.com' }, 'POST'), ['maps.example.com']).ok, true);
  assert.equal(checkRequest(req({ host: 'maps.example.com', origin: 'https://evil.example' }, 'POST'), ['maps.example.com']).ok, false, 'its own origin only');
});

/** Status of a WebSocket handshake: 101 when the server upgrades, otherwise the refusal. */
const handshake = (port: number, origin?: string): Promise<number> => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...(origin ? { Origin: origin } : {}) } });
  request.on('upgrade', (response, socket) => { resolve(response.statusCode ?? 0); socket.destroy(); });
  request.on('response', response => { resolve(response.statusCode ?? 0); response.resume(); });
  request.on('error', reject); request.end();
});

const call = (port: number, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, path: '/x', method, headers }, response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
  });
  request.on('error', reject); request.end();
});

test('a real server answers 403 to a forged Host or Origin and serves the rest, for requests and WebSocket handshakes', async () => {
  const server = http.createServer((request, response) => { if (!guardRequest(request, response)) return; response.writeHead(200); response.end('served'); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => { if (!guardUpgrade(request, socket)) return; wss.handleUpgrade(request, socket, head, () => {}); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.deepEqual(await call(port, {}), { status: 200, body: 'served' }, 'the default Host (127.0.0.1:port)');
    assert.equal((await call(port, { Host: 'attacker.example' })).status, 403);
    assert.equal((await call(port, { Origin: 'https://attacker.example' }, 'POST')).status, 403);
    const refused = await call(port, { Origin: 'https://attacker.example' }, 'POST');
    assert.match(refused.body, /"reason":"cross-origin request"/);

    assert.equal(await handshake(port), 101, 'a program without an Origin');
    assert.equal(await handshake(port, `http://127.0.0.1:${port}`), 101, 'the page of the app itself');
    assert.equal(await handshake(port, 'https://attacker.example'), 403, 'a page on another site opening the live feed');
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
