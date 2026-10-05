import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { createLocalServer, sendUiStaticResponse, type UiStaticRoots } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';

class CapturedResponse extends Writable {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  writeHead(statusCode: number, headers: Record<string, string>) { this.statusCode = statusCode; this.headers = headers; }
  override _write(chunk: unknown, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.body += chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
    done();
  }
}

function assetFixture() {
  const runtimeRoot = path.resolve(process.cwd(), 'data', 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(runtimeRoot, 'ui-static-'));
  const roots = { builtRoot: path.join(directory, 'dist'), sourceRoot: path.join(directory, 'source') };
  fs.mkdirSync(roots.builtRoot); fs.mkdirSync(roots.sourceRoot);
  fs.writeFileSync(path.join(roots.sourceRoot, 'index.html'), '<script type="module" src="/app.ts"></script>');
  fs.writeFileSync(path.join(roots.sourceRoot, 'app.ts'), 'const sourceOnly: string = "typescript";');
  fs.writeFileSync(path.join(roots.sourceRoot, 'styles.css'), 'body { color: black; }');
  return {
    roots,
    directory,
    close() {
      const relative = path.relative(runtimeRoot, path.resolve(directory));
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function uiResponse(pathname: string, roots: UiStaticRoots) {
  const response = new CapturedResponse();
  const completed = once(response, 'finish');
  sendUiStaticResponse(response, pathname, roots);
  await completed;
  return response;
}

test('missing compiled UI returns an explicit build-required response instead of source HTML', async () => {
  const fixture = assetFixture();
  try {
    for (const pathname of ['/', '/index.html']) {
      const response = await uiResponse(pathname, fixture.roots);
      assert.equal(response.statusCode, 503);
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
      const payload: unknown = JSON.parse(response.body);
      assert.deepEqual(payload, {
        error: 'UI build required',
        code: 'UI_BUILD_REQUIRED',
        message: 'Run npm run build to generate the local UI, or use npm run ui for Vite development. API routes remain available.',
      });
      assert.doesNotMatch(response.body, /<script|app\.ts|sourceOnly/);
    }
    const style = await uiResponse('/styles.css', fixture.roots);
    assert.equal(style.statusCode, 200);
    assert.equal(style.headers['content-type'], 'text/css; charset=utf-8');
  } finally { fixture.close(); }
});

test('compiled UI and normal source asset fallback retain their content and MIME types', async () => {
  const fixture = assetFixture();
  try {
    fs.writeFileSync(path.join(fixture.roots.builtRoot, 'index.html'), '<script type="module" src="/app.js"></script>');
    fs.writeFileSync(path.join(fixture.roots.builtRoot, 'app.js'), 'const compiled = true;');
    const root = await uiResponse('/', fixture.roots);
    assert.equal(root.statusCode, 200);
    assert.equal(root.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(root.body, /app\.js/);
    assert.doesNotMatch(root.body, /app\.ts/);
    const script = await uiResponse('/app.js', fixture.roots);
    assert.equal(script.statusCode, 200);
    assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(script.body, 'const compiled = true;');
    const style = await uiResponse('/styles.css', fixture.roots);
    assert.equal(style.statusCode, 200);
    assert.equal(style.body, 'body { color: black; }');
  } finally { fixture.close(); }
});

test('static UI routing keeps traversal, missing files, and directories blocked', async () => {
  const fixture = assetFixture();
  try {
    fs.writeFileSync(path.join(fixture.directory, 'outside.txt'), 'private sibling');
    fs.mkdirSync(path.join(fixture.roots.sourceRoot, 'folder'));
    for (const pathname of ['/../outside.txt', '/missing.js', '/folder']) {
      const response = await uiResponse(pathname, fixture.roots);
      assert.equal(response.statusCode, 404);
      assert.doesNotMatch(response.body, /private sibling/);
    }
  } finally { fixture.close(); }
});

test('API health dispatch remains usable on an unlistening server without UI initialization', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const socket = new Socket();
  try {
    const request = new IncomingMessage(socket);
    request.method = 'GET'; request.url = '/api/health';
    const response = new CapturedResponse();
    const completed = once(response, 'finish');
    assert.equal(app.server.listening, false);
    app.server.emit('request', request, response);
    await completed;
    assert.equal(response.statusCode, 200);
    const payload: unknown = JSON.parse(response.body);
    assert.ok(payload !== null && typeof payload === 'object' && 'ok' in payload && payload.ok === true);
    assert.equal(app.server.listening, false);
  } finally { socket.destroy(); await app.close(); }
});
