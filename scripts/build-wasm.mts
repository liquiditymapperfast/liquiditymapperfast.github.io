// Build the Rust kernels to wasm and generate the browser glue into src/app/wasm.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const crate = path.join(root, 'crates', 'hlm-kernels');
const out = path.join(root, 'src', 'app', 'wasm');
const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], crate);
// The assets that work now are replaced only by new ones that exist: generated beside them first, and swapped in once they are checked,
// so a build that fails half way leaves the old ones where they were.
const staged = `${out}.new`;
fs.rmSync(staged, { recursive: true, force: true });
try {
  run('wasm-bindgen', ['--target', 'web', '--out-dir', staged, '--out-name', 'hlm_kernels', path.join(crate, 'target', 'wasm32-unknown-unknown', 'release', 'hlm_kernels.wasm')], root);
  const size = fs.statSync(path.join(staged, 'hlm_kernels_bg.wasm')).size;
  if (!(size > 0) || !fs.existsSync(path.join(staged, 'hlm_kernels.js'))) throw new Error('wasm-bindgen did not produce the kernels');
  fs.rmSync(out, { recursive: true, force: true });
  fs.renameSync(staged, out);
  console.log(`wasm kernels built: ${size} bytes -> ${path.relative(root, out)}`);
} catch (error) {
  fs.rmSync(staged, { recursive: true, force: true });
  throw error;
}
