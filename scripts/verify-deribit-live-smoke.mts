import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPublicDepthLiveSmoke } from './public-depth-live-smoke.mts';

const timeoutMs = Math.max(1_000, Number(process.env.DERIBIT_SMOKE_TIMEOUT_MS ?? 20_000));
const reconnectTimeoutMs = Math.max(1_000, Number(process.env.DERIBIT_SMOKE_RECONNECT_TIMEOUT_MS ?? timeoutMs));
const artifact = await runPublicDepthLiveSmoke({ providers: ['deribit'], timeoutMs, reconnectTimeoutMs });
const output = process.env.DERIBIT_SMOKE_OUTPUT ?? path.resolve(process.cwd(), 'docs/acceptance/visual-parity/m9-venues/deribit-live-smoke-2026-09-13.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, status: artifact.status, providers: artifact.providers.map(({ venue, status, error }) => ({ venue, status, ...(error ? { error } : {}) })) }, null, 2));
if (artifact.status !== 'read-only-live-observation') process.exitCode = 2;
