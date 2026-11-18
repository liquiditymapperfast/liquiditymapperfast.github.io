import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Plus ships with two trader groups, everyone and HyperTracker's profitable traders (Karl, 2026-11-18). A group that was removed must not be
 * named anywhere a visitor or a reader of the repository's pages could meet it: the page's code and its language packs, the Guide and the
 * help (both in src/app), README.md and docs/plus.md. Words that merely contain the letters ("provenance") are not the name.
 */
const ROOT = process.cwd();
const NAME = /\bproven\b/i;
const TEXT = new Set(['.ts', '.mts', '.js', '.mjs', '.json', '.css', '.html', '.md', '.txt', '.webmanifest', '.svg', '.xml', '_headers']);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full));
    else if (TEXT.has(path.extname(entry.name)) || TEXT.has(entry.name)) out.push(full);
  }
  return out;
}

test('a removed trader group is named nowhere in the page, its packs, the Guide, the help, README.md or docs/plus.md', () => {
  const scanned = [...files(path.join(ROOT, 'src', 'app')), path.join(ROOT, 'README.md'), path.join(ROOT, 'docs', 'plus.md')];
  const rel = scanned.map(f => path.relative(ROOT, f).split(path.sep).join('/'));
  // The walk reaches what it must: the packs, the Guide and its packs, the help.
  for (const must of ['src/app/i18n/de.json', 'src/app/guide/i18n/zh.json', 'src/app/guide/content.ts', 'src/app/help.ts', 'src/app/plus/page.ts', 'README.md', 'docs/plus.md']) assert.ok(rel.includes(must), must);
  const hits: string[] = [];
  scanned.forEach((file, i) => {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, n) => { if (NAME.test(line)) hits.push(`${rel[i]}:${n + 1}: ${line.trim().slice(0, 120)}`); });
  });
  assert.deepEqual(hits, []);
  assert.ok(!NAME.test('provenance unproven'), 'other words with those letters are not the name');
});
