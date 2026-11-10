import test from 'node:test';
import assert from 'node:assert/strict';
import { NEW_SCRIPT, panelClosed, sameOptions, statusOf, unsaved, type ScriptsHost, type ScriptsPanelState } from '../src/app/script/panel-state.ts';
import { ROW_DEFAULT, SCRIPT_API, type ScriptRecord } from '../src/app/script/records.ts';
import type { ScriptResult } from '../src/app/script/protocol.ts';

const vwap: ScriptRecord = { id: 'vwap-with-bands', name: 'VWAP with bands', source: 'line(1)', options: { len: 48 }, on: true, api: SCRIPT_API, height: ROW_DEFAULT, place: 'map' };

function host(records: ScriptRecord[], results: Record<string, ScriptResult> = {}, running = true): ScriptsHost {
  return {
    records, running,
    setRecords: () => true, resultOf: id => results[id] ?? null, warningsOf: () => [], analysisOf: () => ({ code: 'empty', line: 0, col: 0 }), showScripts: () => {}, ranOn: () => null,
    bars: 10_000, setBars: () => {}, barsState: () => ({ state: 'ready', have: 10_000, want: 10_000, market: 'Binance BTCUSDT' }),
  };
}
const editing = (id: string, draft: Partial<NonNullable<ScriptsPanelState['draft']>> = {}): ScriptsPanelState =>
  ({ editing: id, draft: { name: vwap.name, source: vwap.source, options: { ...vwap.options }, place: vwap.place, ...draft }, message: { text: 'Saved', error: false }, armed: 'x' });

test('a script opened and left unchanged opens on the list next time; one with changes opens where it was, saying so', () => {
  const h = host([vwap]);
  const same = editing(vwap.id);
  assert.equal(unsaved(h, same), false, 'opening the VWAP and closing the panel changed nothing');
  panelClosed(h, same);
  assert.deepEqual(same, { editing: null, draft: null, message: null, armed: null, about: null });

  for (const change of [{ source: 'line(2)' }, { name: 'My VWAP' }, { place: 'pane' as const }, { options: { len: 20 } }]) {
    const ui = editing(vwap.id, change);
    assert.equal(unsaved(h, ui), true, JSON.stringify(change));
    panelClosed(h, ui);
    assert.equal(ui.editing, vwap.id, 'the changes are kept');
    assert.equal(ui.message?.error, false);
    assert.ok(ui.message?.text, 'and it says they are not saved');
    assert.equal(ui.armed, null);
  }
  assert.equal(unsaved(h, editing(vwap.id, { name: `  ${vwap.name} ` })), false, 'a name as it would be kept');
  const two = host([{ ...vwap, options: { len: 14, mult: 2 } }]);
  assert.equal(unsaved(two, editing(vwap.id, { options: { mult: 2, len: 14 } })), false, 'an option cleared and set back to its value: the same options, in another order');
  assert.equal(unsaved(two, editing(vwap.id, { options: { mult: 2, len: 15 } })), true);
  assert.equal(sameOptions({ len: 0 }, { len: -0 }), false, '-0 is another value to a script (1 / len)');
  assert.equal(sameOptions({ a: 1, b: 2 }, { b: 2, a: 1 }), true);

  const empty: ScriptsPanelState = { editing: 'new', draft: { name: '', source: '  \n', options: {}, place: 'pane' }, message: null, armed: null };
  assert.equal(unsaved(h, empty), false, 'a new script nothing was written in');
  panelClosed(h, empty);
  assert.equal(empty.editing, null);
  // A new script is never taken for a kept one, even one whose id reads "new" (an imported file may name it so).
  const named = host([{ ...vwap, id: 'new', source: 'line(2)' }]);
  assert.equal(unsaved(named, { editing: NEW_SCRIPT, draft: { name: '', source: 'line(2)', options: {}, place: 'map' }, message: null, armed: null }), true);
  assert.ok(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(NEW_SCRIPT), 'no id can be the marker');
  const written: ScriptsPanelState = { editing: 'new', draft: { name: '', source: 'line(1)', options: {}, place: 'pane' }, message: null, armed: null };
  panelClosed(h, written);
  assert.equal(written.editing, 'new');
});

test('a row says where its script draws and how its last run went', () => {
  const ok: ScriptResult = { id: vwap.id, ok: true, plots: [{ kind: 'line', title: 'VWAP', style: {}, fields: { value: new Float64Array(1) }, colors: null }, { kind: 'line', title: '+SD', style: {}, fields: { value: new Float64Array(1) }, colors: null }], warnings: [], steps: 1, ms: 1 };
  assert.match(statusOf(host([vwap], { [vwap.id]: ok }), vwap).text, /map.*2/i);
  assert.deepEqual(statusOf(host([vwap]), vwap).error, false);
  assert.notEqual(statusOf(host([vwap], {}, true), vwap).text, statusOf(host([vwap], {}, false), vwap).text, 'waiting for a run is not the same as Scripts being off');
  const failed: ScriptResult = { id: vwap.id, ok: false, error: { code: 'worker-failed', line: 0, col: 0 } };
  assert.equal(statusOf(host([vwap], { [vwap.id]: failed }), vwap).error, true);
  assert.equal(statusOf(host([vwap], { [vwap.id]: failed }), { ...vwap, on: false }).error, false, 'a script switched off shows no error');
  assert.match(statusOf(host([vwap]), { ...vwap, place: 'pane' }).text, /row/i);
});
