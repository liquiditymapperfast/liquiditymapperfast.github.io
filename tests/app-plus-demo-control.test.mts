import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDemoStore } from '../src/app/plus/demo/store.ts';
import { demoControl, demoLevels } from '../src/app/plus/demo-levels.ts';
import { demoWith, openSheet, closeSheet } from '../src/app/plus/sheet.ts';
import { Store, initialState } from '../src/app/store.ts';
import { FakeElement, FakePage } from './fake-dom.mts';

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
const member = { state: 'none' as const, until: null, subscribe: () => () => {} };
/** The history index the sheet reads for its first date: stood in for, so a test asks nothing of the network. */
function noNetwork(): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => new Response('null', { status: 404 })) as typeof fetch;
  return () => { globalThis.fetch = saved; };
}

test('the demo\'s levels control is the page\'s own, on the demo\'s store: its switches and traders change the demo, never the page\'s settings', () => {
  const page = new FakePage(), done = page.install();
  try {
    const app = new Store(initialState()), before = JSON.stringify(app.state.liqLevels);
    const store = createDemoStore();
    assert.deepEqual(demoLevels(store).get(), { liq: true, stops: true, takes: true, group: 'all' }, 'everyone as the page\'s "all"');
    assert.equal(demoLevels(store).member(), true, 'every choice open in the demo');
    const host = new FakeElement('DIV'); page.body.append(host);
    const control = demoControl(host as unknown as HTMLElement, store);
    const root = host.querySelector('.lv')!;
    assert.ok(root, 'the levels control, built into the demo\'s card');
    root.querySelector('[data-part="stops"]')!.click();
    assert.equal(store.get().stops, false);
    root.querySelector('[data-group="profitable"]')!.click();
    assert.equal(store.get().traders, 'profitable');
    // The tour changes the store: the control follows.
    store.set({ takes: false });
    assert.equal(root.querySelector('[data-part="takes"]')!.getAttribute('aria-checked'), 'false');
    // One kind always stays on (the demo store's own rule as the control's).
    root.querySelector('[data-part="liq"]')!.click();
    assert.equal(store.get().liq, true, 'the last kind on stays on');
    assert.equal(JSON.stringify(app.state.liqLevels), before, 'the page\'s settings untouched');
    control.destroy();
    assert.equal(host.querySelector('.lv'), null, 'taken out when the demo goes');
    store.set({ takes: true });
  } finally { done(); }
});

test('the sheet mounts the demo once it has opened, in its own stage (no panel around it, so no theme strips its control), and takes it down as it closes', async () => {
  const page = new FakePage(), done = page.install(), net = noNetwork();
  try {
    const calls: { stage: FakeElement; destroyed: boolean }[] = [];
    demoWith(stage => { const call = { stage: stage as unknown as FakeElement, destroyed: false }; calls.push(call); return { destroy: () => { call.destroyed = true; } }; });
    const opener = new FakeElement('BUTTON'); page.body.append(opener);
    openSheet(opener as unknown as HTMLElement, member);
    assert.equal(calls.length, 0, 'not while the sheet is still opening');
    await flush();
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.stage.classList.contains('px-stage') && calls[0]!.stage.isConnected);
    assert.equal(calls[0]!.stage.closest('.panel'), null, 'outside any panel');
    closeSheet(true);
    assert.equal(calls[0]!.destroyed, true, 'destroyed with the sheet');
    // Closed before the demo mounted: it never mounts.
    openSheet(opener as unknown as HTMLElement, member); closeSheet(); await flush();
    assert.equal(calls.length, 1);
  } finally { demoWith(null); net(); done(); }
});

test('the sheet and its demo are fetched only when the sheet first opens, the styles with them', () => {
  const src = (file: string): string => fs.readFileSync(path.join(process.cwd(), 'src/app/plus', file), 'utf8');
  assert.match(src('panel.ts'), /import\('\.\/sheet-entry\.ts'\)/);
  const entry = src('sheet-entry.ts');
  for (const want of [/import '\.\/present\.css';/, /import '\.\/sheet\.css';/, /from '\.\/demo\/index\.ts'/]) assert.match(entry, want);
  assert.ok(!/\.css'/.test(src('sheet.ts')), 'the sheet itself carries no styles (tested without them)');
});
