// Build the Rust kernels to wasm and generate the browser glue into src/app/wasm.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const crate = path.join(root, 'crates', 'hlm-kernels');
const out = path.join(root, 'src', 'app', 'wasm');
const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], crate);
fs.rmSync(out, { recursive: true, force: true });
run('wasm-bindgen', ['--target', 'web', '--out-dir', out, '--out-name', 'hlm_kernels', path.join(crate, 'target', 'wasm32-unknown-unknown', 'release', 'hlm_kernels.wasm')], root);
const size = fs.statSync(path.join(out, 'hlm_kernels_bg.wasm')).size;
console.log(`wasm kernels built: ${size} bytes -> ${path.relative(root, out)}`);
