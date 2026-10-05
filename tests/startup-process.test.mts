import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HistoryStore } from '../src/server/history.mts';

import { defined, fields } from './server-test-helpers.mts';
interface FixtureProcessResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; output: string; }
const repoRoot = path.resolve(process.cwd());
const fixtureLauncher = fileURLToPath(new URL('../scripts/start-fixture.mjs', import.meta.url));

function cleanEnvironment(overrides: NodeJS.ProcessEnv = {}) {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of ['HISTORY_DB', 'PORT', 'QUOTA_FILE', 'ENABLE_HYPERTRACKER', 'HYPERTRACKER_API_KEY', 'HYPERTRACKER_BASE_URL', 'HYPERTRACKER_LIQUIDATION_PATH', 'HYPERTRACKER_STOP_LOSS_PATH', 'HYPERTRACKER_TAKE_PROFIT_PATH', 'HYPERTRACKER_INITIAL_REFRESH_MS', 'HLM_TEST_FAIL_STAGE', 'HLM_TEST_SHUTDOWN_AFTER_MS', 'HLM_SEED_M5_TEMPORAL', 'HLM_SEED_SENSITIVITY_HISTORY', 'HLM_SEED_PROVIDER_HISTORY']) {
    if (overrides[key] === undefined) delete environment[key];
  }
  return environment;
}

function runFixture(overrides: NodeJS.ProcessEnv = {}, timeoutMs = 12_000) {
  return new Promise<FixtureProcessResult>((resolve, reject) => {
    const generatedQuotaPath = overrides.QUOTA_FILE == null
      ? path.join(os.tmpdir(), `hlm-startup-quota-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
      : null;
    const quotaPath = overrides.QUOTA_FILE ?? defined(generatedQuotaPath);
    const child = spawn(process.execPath, [fixtureLauncher], {
      cwd: repoRoot,
      env: cleanEnvironment({ ...overrides, QUOTA_FILE: quotaPath }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      if (generatedQuotaPath) fs.rmSync(generatedQuotaPath, { force: true });
      reject(new Error(`fixture process timed out\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); if (generatedQuotaPath) fs.rmSync(generatedQuotaPath, { force: true }); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (generatedQuotaPath) fs.rmSync(generatedQuotaPath, { force: true });
      resolve({ code, signal, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

function startupRecord(output: string) {
  const line = output.split(/\r?\n/).find((item) => item.includes('"event":"startup-failed"'));
  assert.ok(line, `startup failure record missing\n${output}`);
  const record: unknown = JSON.parse(line);
  return fields(record);
}

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function canBind(port: number) {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('fixture startup rejects readonly history before listening with path and SQLite code', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-startup-readonly-'));
  const historyPath = path.join(directory, 'history.sqlite');
  const history = new HistoryStore({ filePath: historyPath });
  history.close();
  fs.chmodSync(historyPath, 0o444);
  try {
    const result = await runFixture({ PORT: '0', HISTORY_DB: historyPath });
    const record = startupRecord(result.output);
    assert.equal(result.code, 1);
    assert.equal(record.stage, 'history-initialization');
    assert.equal(record.mode, 'fixture');
    assert.equal(record.historyPath, path.normalize(historyPath));
    assert.equal(record.classification, 'sqlite-readonly');
    assert.equal(record.errcode, 8);
    assert.doesNotMatch(result.output, /local server listening/);
  } finally {
    fs.chmodSync(historyPath, 0o666);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('post-listen startup failure exits nonzero and releases the listener', async () => {
  const port = await freePort();
  const result = await runFixture({ PORT: String(port), HLM_TEST_FAIL_STAGE: 'feed-start' });
  const record = startupRecord(result.output);
  assert.equal(result.code, 1);
  assert.equal(record.stage, 'feed-start');
  assert.equal(record.code, 'HLM_TEST_FAILURE');
  assert.doesNotMatch(result.output, /local server listening/);
  assert.equal(await canBind(port), true);
});

test('explicit persistent history path can be opened across fixture restarts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-startup-persistent-'));
  const historyPath = path.join(directory, 'history.sqlite');
  const environment = { PORT: '0', HISTORY_DB: historyPath, HLM_TEST_SHUTDOWN_AFTER_MS: '250', FIXTURE_TICK_MS: '40' };
  try {
    const first = await runFixture(environment);
    const second = await runFixture(environment);
    for (const result of [first, second]) {
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /local server listening/);
      assert.doesNotMatch(result.output, /startup-failed/);
    }
    assert.ok(fs.statSync(historyPath).size > 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
