#!/usr/bin/env node
// Botkeep/Pterodactyl entrypoint: the egg does not hand container env vars to the
// process, so this reads the .env file the panel writes (Environment tab) and
// exports it before the server starts. HLM_HOST makes it listen on the allocated
// interface and PORT (Pterodactyl standard) picks the allocated port.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  const raw = readFileSync(resolve('.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    let v = t.slice(eq + 1).trim();
    if (v.length >= 2 && v[0] === v.at(-1) && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
    process.env[t.slice(0, eq).trim()] ??= v;
  }
  console.log('[botkeep-start] .env loaded');
} catch { console.log('[botkeep-start] no .env, using container env'); }

process.env.ENABLE_LIVE_FEEDS = 'true';
process.env.HLM_HOST ??= '0.0.0.0';
await import('../../build/tools/scripts/start-live.mjs');
