// Sol's review of the presentation sheet (2026-11-19, 7fceead4..a3233f19): each finding's case, which the code before the fixes failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSheet, openSheet, sheetOpen } from '../src/app/plus/sheet.ts';
import { FakeElement, FakePage } from './fake-dom.mts';

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
function noNetwork(): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => new Response('null', { status: 404 })) as typeof fetch;
  return () => { globalThis.fetch = saved; };
}
function membership(state: 'none' | 'checking' | 'ended' | 'on', until: number | null = null) {
  const listeners = new Set<() => void>();
  const m = { state, until, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    change(next: { state: 'none' | 'checking' | 'ended' | 'on'; until?: number | null }) { m.state = next.state; if (next.until !== undefined) m.until = next.until; for (const l of [...listeners]) l(); } };
  return m;
}

test('Sol sheet 1 (P2): Escape goes to the sheet on top only: the phone\'s Settings under it stays open', async () => {
  const page = new FakePage(), done = page.install(), net = noNetwork();
  try {
    // The Settings sheet's own rule (src/app/sheet.ts): its Escape closes it unless a panel, a menu or a dialog is open over it.
    let settingsOpen = true;
    const settingsKey = (e: { key: string }): void => { if (e.key !== 'Escape' || document.querySelector('.panel, .menu, dialog[open]')) return; settingsOpen = false; };
    page.listeners.set('keydown', new Set([settingsKey as never]));
    const tile = new FakeElement('BUTTON'); page.body.append(tile);
    openSheet(tile as unknown as HTMLElement, membership('none'));
    assert.ok(document.querySelector('dialog[open]'), 'the sheet is the page\'s dialog on top');
    page.key('Escape');
    assert.equal(sheetOpen(), false, 'the Plus sheet closed');
    assert.equal(settingsOpen, true, 'Settings under it did not');
    assert.equal(document.querySelector('dialog[open]'), null);
  } finally { closeSheet(); net(); done(); }
});

test('Sol sheet 2 (P2): the access card says where the membership stands as it changes, its key form staying (what is typed in it too)', async () => {
  const page = new FakePage(), done = page.install(), net = noNetwork();
  try {
    const m = membership('checking'), opener = new FakeElement('BUTTON'); page.body.append(opener);
    openSheet(opener as unknown as HTMLElement, m);
    const access = page.body.querySelector('.px-access')!, form = access.querySelector('.key-form')!, input = access.querySelector('.key-in')!;
    assert.ok(access.textContent.includes('Checking Plus with the server…'));
    input.value = 'typed so far';
    m.change({ state: 'ended', until: Date.UTC(2026, 10, 18) });
    assert.ok(!access.textContent.includes('Checking Plus with the server…'), 'the check is over: not said any more');
    assert.ok(access.textContent.includes('Plus ended on'), 'ended, and when');
    assert.equal(access.querySelector('.key-form'), form, 'the same form'); assert.equal(input.value, 'typed so far');
    m.change({ state: 'none', until: null });
    assert.ok(!access.textContent.includes('Plus ended on') && !access.textContent.includes('Checking'), 'none: nothing said of a membership');
    assert.equal(access.querySelector('.key-form'), form);
    m.change({ state: 'on', until: Date.UTC(2027, 1, 19) });
    assert.equal(access.querySelector('.key-form'), null, 'Plus on: the form goes');
    assert.ok(access.textContent.includes('Plus is on in this browser, until'));
  } finally { closeSheet(); net(); done(); }
});

test('Sol sheet 3 (P2): where what opened the sheet is gone, closing gives the keyboard to the toolbar\'s Plus button', async () => {
  const page = new FakePage(), done = page.install(), net = noNetwork();
  try {
    const toolbar = new FakeElement('DIV'); toolbar.className = 'toolbar';
    const plusButton = new FakeElement('BUTTON'); plusButton.className = 'plus-btn';
    toolbar.append(plusButton); page.body.append(toolbar);
    const lock = new FakeElement('BUTTON'); page.body.append(lock);
    openSheet(lock as unknown as HTMLElement, membership('none'));
    lock.remove();   // the Depth pane's lock goes once Plus is on
    page.key('Escape');
    assert.equal(page.activeElement, plusButton, 'not left on the body');
    // Where the lock is still there, it gets the keyboard back.
    const lock2 = new FakeElement('BUTTON'); page.body.append(lock2);
    openSheet(lock2 as unknown as HTMLElement, membership('none'));
    page.key('Escape');
    assert.equal(page.activeElement, lock2);
    await flush();
  } finally { closeSheet(); net(); done(); }
});
