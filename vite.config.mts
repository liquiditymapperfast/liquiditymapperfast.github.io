import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import path from 'node:path';

/**
 * The page's first script waits for its language and then imports the rest (`boot.ts`), and the rest starts the workers and the kernels:
 * each a round trip after the one before, some 0.4 s each from GitHub Pages (Research_Findings.md, 2026-11-07). Named in the HTML they are
 * fetched beside the first script: the rest and its styles at once, the workers and the kernels into the cache for when they are asked for.
 */
function preloadChain(): Plugin {
  return {
    name: 'hlm-preload-chain',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const files = Object.values(ctx.bundle ?? {}), tags: HtmlTagDescriptor[] = [];
        // The chunk that holds main.ts (imported by boot.ts when the language is known, so a dynamic entry: it has no facade module).
        const main = files.find(f => f.type === 'chunk' && f.moduleIds.some(id => id.replace(/\\/g, '/').endsWith('/src/app/main.ts')));
        if (main?.type === 'chunk') {
          tags.push({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: `./${main.fileName}` }, injectTo: 'head' });
          for (const css of main.viteMetadata?.importedCss ?? []) tags.push({ tag: 'link', attrs: { rel: 'preload', as: 'style', crossorigin: true, href: `./${css}` }, injectTo: 'head' });
        }
        for (const f of files) {
          // The kernels are fetched by their glue (`fetch`, so as a fetch, with the page's credentials); the workers are not something a
          // preload can stand in for, but a prefetch leaves them in the cache (the site's files may be kept ten minutes).
          if (/\.wasm$/.test(f.fileName)) tags.push({ tag: 'link', attrs: { rel: 'preload', as: 'fetch', type: 'application/wasm', crossorigin: true, href: `./${f.fileName}` }, injectTo: 'head' });
          else if (/(^|\/)(feeds|raster)\.worker-[\w-]+\.js$/.test(f.fileName)) tags.push({ tag: 'link', attrs: { rel: 'prefetch', href: `./${f.fileName}` }, injectTo: 'head' });
        }
        return tags;
      },
    },
  };
}

export default defineConfig({
  root: path.resolve('src/app'),
  // Relative URLs, so the build works from any folder: the site root, a GitHub Pages project path, or a file share.
  base: './',
  publicDir: path.resolve('src/app/public'),
  plugins: [preloadChain()],
  // Source maps embed the original TypeScript; HLM_SOURCEMAP=off leaves them out of a build that will be published (docs/deployment.md).
  build: { outDir: path.resolve('dist'), emptyOutDir: true, sourcemap: process.env.HLM_SOURCEMAP !== 'off', target: 'es2022' },
  // A language file is one big object that is only read: the page gets it as a JSON string to parse rather than as code to run.
  json: { stringify: true },
  worker: { format: 'es' },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } } },
});
