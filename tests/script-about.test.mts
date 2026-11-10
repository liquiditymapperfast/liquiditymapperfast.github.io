import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LANGUAGES, setLanguage, type Entry } from '../src/app/i18n.ts';
import { aboutExample, aboutScript, builtinOf, exampleId } from '../src/app/script/about.ts';
import { examples, type ExampleKey } from '../src/app/script/examples.ts';
import { HEATMAP_ID, STARTER_ID, starterScripts } from '../src/app/script/starter.ts';
import { ROW_DEFAULT, SCRIPT_API, exportFile, importText, newId, readScript, type ScriptRecord } from '../src/app/script/records.ts';
import { buildScriptsPanel, type ScriptsHost, type ScriptsPanelState } from '../src/app/script/panel.ts';

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;
const record = (id: string, source: string, name = 'x'): ScriptRecord => ({ id, name, source, options: {}, on: true, api: SCRIPT_API, height: ROW_DEFAULT, place: 'pane' });
const source = (key: ExampleKey): string => examples().find(e => e.key === key)!.source;

test('every script that comes with the page has a description: a lead sentence and a few short paragraphs, titled with its name', () => {
  const keys = examples().map(e => e.key);
  assert.equal(new Set(keys).size, keys.length, 'each example has a key of its own');
  assert.deepEqual(keys.slice(0, 2), [STARTER_ID, HEATMAP_ID], 'the starters are the first examples, keyed by their ids');
  for (const ex of examples()) {
    const about = aboutExample(ex.key);
    assert.equal(about.title, ex.name);
    assert.ok(about.tip.endsWith('.') && words(about.tip) <= 30, `${ex.key}: the lead is one short sentence`);
    assert.ok(about.body.length >= 2 && about.body.length <= 4, `${ex.key}: ${about.body.length} paragraphs`);
    const total = words([about.tip, ...about.body].join(' '));
    // Compact enough to read in the popover (Bar patterns, the longest, says which line is which and when the hour's open is there).
    assert.ok(total >= 80 && total <= 190, `${ex.key}: ${total} words`);
  }
  // Honest about what the patterns are: they describe, and no test has shown them to say where price goes.
  assert.match(aboutExample('bar-patterns').body.join(' '), /no test has shown/);
});

test('each description is read in the page\'s language, from every pack', () => {
  const english = new Map(examples().map(e => [e.key, aboutExample(e.key)]));
  const dir = path.join('src', 'app', 'i18n');
  const codes = fs.readdirSync(dir).filter(f => /^[a-z]{2}\.json$/.test(f)).map(f => f.slice(0, 2));
  assert.equal(codes.length, LANGUAGES.length - 1, 'a pack for every language but English');
  try {
    for (const code of codes) {
      const pack = JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8')) as Record<string, Entry>;
      setLanguage(code, pack);
      for (const [key, en] of english) {
        const said = aboutExample(key);
        assert.equal(said.title, pack[en.title], `${code} ${key}: its name`);
        assert.equal(said.tip, pack[en.tip], `${code} ${key}: its lead`);
        assert.deepEqual(said.body, en.body.map(p => pack[p]), `${code} ${key}: its paragraphs`);
        for (const text of [said.tip, ...said.body]) assert.ok(typeof text === 'string' && !en.body.includes(text) && text !== en.tip, `${code} ${key}: translated`);
      }
    }
  } finally { setLanguage('en'); }
});

test('a script is the page\'s own by its id, whatever is changed in it; a person\'s own script, whatever it is called, has no description', () => {
  // The starters, by their ids, with their text changed too.
  for (const r of starterScripts()) assert.equal(builtinOf(r), r.id);
  assert.equal(builtinOf(record(STARTER_ID, 'line(1)')), STARTER_ID, 'an edited starter keeps its description');
  // An example added from the panel carries its key, two dashes and a tail: an id the page keeps as it is, in storage and in a file.
  const id = exampleId('bar-patterns', () => 0.5);
  assert.match(id, /^bar-patterns--[a-z0-9]{6}$/);
  assert.equal(readScript(record(id, 'line(1)'))?.id, id, 'a stored or imported script keeps that id');
  assert.equal(builtinOf(record(id, 'line(2)', 'My patterns')), 'bar-patterns', 'renamed and edited, it is still the example');
  const read = importText(exportFile([record(id, 'line(2)')]), 'x');
  assert.ok('scripts' in read && builtinOf(read.scripts[0]!) === 'bar-patterns', 'exported and read back in another browser');
  assert.equal(aboutScript(record(id, 'line(2)'))?.title, 'Bar patterns');
  // A person's own script, named like an example: newId never writes two dashes in a row, so it can never look like one.
  for (const name of ['Bar patterns', 'bar--patterns', 'Bar - - patterns!', 'Liquidations', '--', 'VWAP with bands']) {
    const own = newId(name, () => 0.25);
    assert.ok(!own.includes('--'), own);
    assert.equal(builtinOf(record(own, 'line(cum(vbuy - vsell))')), null, `${name}: ${own}`);
    assert.equal(aboutScript(record(own, 'line(1)')), null);
  }
  // One added before ids carried the key counts while its text is still the example's, word for word.
  assert.equal(builtinOf(record('bar-patterns-k3j2h1', source('bar-patterns'))), 'bar-patterns');
  assert.equal(builtinOf(record('bar-patterns-k3j2h1', `${source('bar-patterns')}// mine\n`)), null);
  assert.equal(builtinOf(record('buy-share-abc123', source('buy-share'))), 'buy-share');
});

/** Just enough of a document for the Scripts panel to be built and its buttons pressed in a test. */
class Fake {
  children: Fake[] = []; className = ''; textContent = ''; dataset: Record<string, string> = {}; attrs = new Map<string, string>();
  onclick: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  get classList(): { add: (...c: string[]) => void; toggle: (c: string, on?: boolean) => void; contains: (c: string) => boolean } {
    const names = (): string[] => this.className.split(' ').filter(Boolean);
    return {
      add: (...c) => { this.className = [...new Set([...names(), ...c])].join(' '); },
      toggle: (c, on) => { const has = names().includes(c), want = on ?? !has; this.className = (want ? [...new Set([...names(), c])] : names().filter(n => n !== c)).join(' '); },
      contains: c => names().includes(c),
    };
  }
  append(...nodes: (Fake | string)[]): void { for (const n of nodes) { if (typeof n === 'string') { const text = new Fake('#text'); text.textContent = n; this.children.push(text); } else this.children.push(n); } }
  replaceChildren(): void { this.children = []; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  all(): Fake[] { return [this, ...this.children.flatMap(c => c.all())]; }
}

test('the Scripts panel gives the page\'s scripts a "?" in the list and every example one, and a "?" opens the description under its row', () => {
  const g = globalThis as { document?: unknown; Option?: unknown };
  const saved = g.document, savedOption = g.Option;
  g.document = { createElement: (tag: string) => new Fake(tag), querySelector: () => null };
  // The panel's select rows (the scripts' candle count) make their choices with `new Option`.
  g.Option = class extends Fake { value: string; constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } };
  try {
    const records = [record(STARTER_ID, 'line(1)', 'My VWAP'), record(newId('Bar patterns', () => 0.1), 'line(2)', 'Bar patterns')];
    const host: ScriptsHost = { records, running: true, setRecords: () => true, resultOf: () => null, warningsOf: () => [], analysisOf: () => ({ code: 'empty', line: 0, col: 0 }), showScripts: () => {}, ranOn: () => null, bars: 10_000, setBars: () => {}, barsState: () => ({ state: 'ready', have: 10_000, want: 10_000, market: 'Binance BTCUSDT' }) };
    const ui: ScriptsPanelState = { editing: null, draft: null, message: null, armed: null };
    const body = new Fake('div');
    const redraw = (): void => { body.replaceChildren(); buildScriptsPanel(host, body as unknown as HTMLElement, redraw, ui); };
    redraw();
    const asks = (): Fake[] => body.all().filter(n => n.tagName === 'button' && n.classList.contains('help'));
    const rows = (cls: string): Fake[] => body.children.filter(n => n.classList.contains(cls));
    assert.equal(rows('script-row')[0]!.children.filter(n => n.classList.contains('help')).length, 1, 'the edited, renamed starter has its "?"');
    assert.equal(rows('script-row')[1]!.children.filter(n => n.classList.contains('help')).length, 0, 'a script of one\'s own named like an example has none');
    assert.equal(asks().length, 1 + examples().length, 'and every example has one');
    assert.equal(body.all().filter(n => n.classList.contains('script-about')).length, 0, 'every description starts closed');

    // The Bar patterns example's "?": its description opens right under its row, the lead first, and stays open as the panel is drawn again.
    const example = rows('script-example').find(r => r.children.some(c => c.textContent === 'Bar patterns'))!;
    example.children.find(c => c.classList.contains('help'))!.onclick!();
    const at = body.children.findIndex(n => n.classList.contains('script-about'));
    assert.ok(at > 0 && body.children[at - 1]!.children.some(c => c.textContent === 'Bar patterns'), 'under its own row');
    const box = body.children[at]!, about = aboutExample('bar-patterns');
    assert.deepEqual(box.children.map(c => c.textContent), [about.tip, ...about.body], 'its lead and paragraphs, and no guide link');
    const opened = asks().find(b => b.attrs.get('aria-expanded') === 'true')!;
    assert.ok(opened.classList.contains('open'));
    redraw();
    assert.equal(body.all().filter(n => n.classList.contains('script-about')).length, 1, 'drawn again, it is still open');
    // The same "?" closes it; another opens its own and closes the first.
    asks().find(b => b.attrs.get('aria-expanded') === 'true')!.onclick!();
    assert.equal(body.all().filter(n => n.classList.contains('script-about')).length, 0);
    rows('script-row')[0]!.children.find(c => c.classList.contains('help'))!.onclick!();
    const boxes = body.children.filter(n => n.classList.contains('script-about'));
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0]!.children[0]!.textContent, aboutExample(STARTER_ID).tip, "the starter's own description, under the list's row");
  } finally { g.document = saved; g.Option = savedOption; }
});
