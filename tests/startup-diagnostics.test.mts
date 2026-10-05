import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startupFailureRecord, normalizeHistoryPath } from '../src/server/startup-diagnostics.mts';

test('startup diagnostics classify readonly SQLite failure without hiding the path', () => {
  const record = startupFailureRecord(Object.assign(new Error('attempt to write a readonly database'), { code: 'ERR_SQLITE_ERROR' }), {
    mode: 'fixture',
    historyPath: ':memory:',
  });
  assert.deepEqual(record, {
    event: 'startup-failed',
    stage: 'startup',
    mode: 'fixture',
    historyPath: ':memory:',
    code: 'ERR_SQLITE_ERROR',
    errcode: null,
    errstr: null,
    classification: 'sqlite-readonly',
    message: 'attempt to write a readonly database',
  });
});

test('startup diagnostics keep SQLITE_BUSY distinct from readonly errors', () => {
  const record = startupFailureRecord(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'SQLITE_BUSY' }), { mode: 'live', historyPath: 'history.sqlite', stage: 'listen' });
  assert.equal(record.classification, 'sqlite-busy');
  assert.equal(record.historyPath, path.resolve('history.sqlite'));
  assert.equal(record.errcode, 5);
  assert.equal(record.errstr, 'SQLITE_BUSY');
  assert.equal(record.stage, 'listen');
});
