import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve('src/app'),
  publicDir: path.resolve('src/app/public'),
  // Source maps embed the original TypeScript; HLM_SOURCEMAP=off leaves them out of a build that will be published (docs/deployment.md).
  build: { outDir: path.resolve('dist'), emptyOutDir: true, sourcemap: process.env.HLM_SOURCEMAP !== 'off', target: 'es2022' },
  worker: { format: 'es' },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } } },
});
