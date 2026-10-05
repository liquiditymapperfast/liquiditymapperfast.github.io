import path from 'node:path';

interface StartupFailureOptions { mode?: unknown; historyPath?: unknown; stage?: string; }
function errorFields(error: unknown): Record<string, unknown> { return error != null && typeof error === 'object' ? error as Record<string, unknown> : {}; }

export function normalizeHistoryPath(historyPath: unknown, cwd = process.cwd()) {
  const raw = String(historyPath ?? '').trim();
  if (!raw || raw === ':memory:') return raw || ':memory:';
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
}

export function startupFailureRecord(error: unknown, { mode, historyPath, stage = 'startup' }: StartupFailureOptions = {}) {
  const detail = errorFields(error);
  const code = detail.code ?? null;
  const errcode = Number.isFinite(Number(detail.errcode)) ? Number(detail.errcode) : null;
  const errstr = detail.errstr ?? null;
  const message = typeof detail.message === 'string' ? detail.message : String(error);
  const classification = code === 'SQLITE_BUSY' || errcode === 5 || /database is locked|sqlite_busy/i.test(message)
    ? 'sqlite-busy'
    : code === 'SQLITE_READONLY' || errcode === 8 || /readonly database|read-only/i.test(message)
      ? 'sqlite-readonly'
      : 'startup-failure';
  return {
    event: 'startup-failed',
    stage,
    mode: mode ?? null,
    historyPath: historyPath == null ? null : normalizeHistoryPath(historyPath),
    code,
    errcode,
    errstr,
    classification,
    message,
  };
}
