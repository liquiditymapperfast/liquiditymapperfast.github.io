import { defineConfig } from 'vite';
import path from 'node:path';

/**
 * The Plus page (plus/: the offer, the checkout and the key; src/app/plus/page.ts), built after the app into the same `dist` and as a
 * build of its own: in one build with the app, the modules the two pages share (the languages, the theme, the levels' addresses) were
 * split out of the app's first script and its main chunk, each a round trip more before the app starts. Here the page carries its own
 * copies, and the app's files are exactly what `vite.config.mts` makes them. The dev server needs none of this: it serves both pages
 * from `src/app`.
 */
export default defineConfig({
  root: path.resolve('src/app'),
  base: './',
  // The public files are the app build's to copy (the Plus page's picture and the legal pages among them).
  publicDir: false,
  build: { outDir: path.resolve('dist'), emptyOutDir: false, sourcemap: process.env.HLM_SOURCEMAP !== 'off', target: 'es2022',
    rollupOptions: { input: { plus: path.resolve('src/app/plus/index.html') } } },
  json: { stringify: true },
});
