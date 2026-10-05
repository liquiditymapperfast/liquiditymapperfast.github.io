import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Keeps other websites out of a server that listens on localhost. A page you visit can make your browser send requests to
 * 127.0.0.1 (a "simple" cross-site POST needs no preflight, so it can change the venue selection or spend API quota), and a DNS name can
 * be re-pointed at 127.0.0.1 so that the page reads the answers as well. Two checks close both:
 *
 * - the Host must be a name this server is meant to answer to (localhost, an IP address, or one listed in `HLM_ALLOWED_HOSTS`),
 *   which defeats DNS rebinding, since a rebound page still carries its own hostname;
 * - a browser's Origin, which it always sends on a WebSocket handshake or a POST, must be this server itself.
 *
 * Programs that are not browsers (curl, the test harnesses) send no Origin and are unaffected.
 */
export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/** The host name of a Host header value: no port, no IPv6 brackets, lower case. */
export function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) { const end = value.indexOf(']'); return end < 0 ? value : value.slice(1, end); }
  const colon = value.lastIndexOf(':');
  return colon < 0 || value.indexOf(':') !== colon ? value : value.slice(0, colon);
}

/** Extra host names to answer to, from `HLM_ALLOWED_HOSTS` (comma separated; a deliberate remote deployment lists its public name here). */
export function extraHostsFromEnv(env: string | undefined = process.env.HLM_ALLOWED_HOSTS): string[] {
  return (env ?? '').split(',').map(item => hostnameOf(item)).filter(Boolean);
}

export function checkRequest(req: Pick<IncomingMessage, 'headers' | 'method'>, extraHosts: readonly string[] = extraHostsFromEnv()): GuardVerdict {
  // A browser always sends a Host, and a rebound page sends its own name in it. A request without one (HTTP/1.0, a hand-built request) has
  // nothing a rebinding page could use, so it is served; the Origin rule below still applies to it.
  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  if (hostHeader) {
    const name = hostnameOf(hostHeader);
    if (!(name === 'localhost' || name.endsWith('.localhost') || net.isIP(name) !== 0 || extraHosts.includes(name))) return { ok: false, reason: `Host ${name} is not allowed` };
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch { /* the null origin and malformed values fall through to the refusal */ }
    if (!originHost || originHost !== hostHeader) return { ok: false, reason: 'cross-origin request' };
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const site = req.headers['sec-fetch-site'];
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && typeof site === 'string' && site !== 'same-origin' && site !== 'none') return { ok: false, reason: 'cross-site request' };
  return { ok: true };
}

/** Answer 403 and return false when the request must not be served. */
export function guardRequest(req: IncomingMessage, res: ServerResponse, extraHosts?: readonly string[]): boolean {
  const verdict = checkRequest(req, extraHosts);
  if (verdict.ok) return true;
  const body = JSON.stringify({ ok: false, error: 'forbidden', reason: verdict.reason });
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  return false;
}

/** The same decision for a WebSocket handshake: refuse it with 403 and close the socket. */
export function guardUpgrade(req: IncomingMessage, socket: Duplex, extraHosts?: readonly string[]): boolean {
  const verdict = checkRequest(req, extraHosts);
  if (verdict.ok) return true;
  socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
  socket.destroy();
  return false;
}
