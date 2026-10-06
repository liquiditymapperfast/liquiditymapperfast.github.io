import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve('src/app'),
  // Relative URLs, so the build works from any folder: the site root, a GitHub Pages project path, or a file share.
  base: './',
  publicDir: path.resolve('src/app/public'),
  // Source maps embed the original TypeScript; HLM_SOURCEMAP=off leaves them out of a build that will be published (docs/deployment.md).
  build: { outDir: path.resolve('dist'), emptyOutDir: true, sourcemap: process.env.HLM_SOURCEMAP !== 'off', target: 'es2022' },
  // A language file is one big object that is only read: the page gets it as a JSON string to parse rather than as code to run.
  json: { stringify: true },
  worker: { format: 'es' },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } } },
});
