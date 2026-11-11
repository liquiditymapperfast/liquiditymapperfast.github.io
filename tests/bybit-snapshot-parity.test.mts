import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFullSnapshot } from '../src/shared/bybit-full-book.ts';

/**
 * What `parseFullSnapshot` makes of odd snapshot answers, one case a row: the body's text, and the page's answer (the reason, or the
 * snapshot without `ts`). Written to tests/fixtures/bybit-snapshot-parity.json (`HLM_WRITE_TRACE=1` rewrites it), which the history
 * recorder's Rust port is held to (HyperLiquidMap_History, `full_book::tests::snapshot_answers_read_as_the_page_reads_them`): the same
 * acceptance and the same order of checks for every case, and the same reason text. Two things a Rust string cannot hold are written as
 * the recorder writes them: half of a UTF-16 pair cut at the 120th unit becomes U+FFFD, and prices are written with `String()` (the
 * recorder parses them back exactly).
 */
const root = process.cwd();
const fixturePath = path.join(root, 'tests/fixtures/bybit-snapshot-parity.json');
const SYMBOL = 'BTCUSDT';
const result = (extra: string): string => `{"s":"BTCUSDT","u":5,"seq":50,"ts":9,"b":[["99","1"],["98","2"]],"a":[["101","1"],["102","2"]]${extra}}`;
const ok = (head: string): string => `{${head}"result":${result('')}}`;
const emoji = '\u{1F600}';

/** [name, body text]. Every body is JSON (an answer that is not is refused before `parseFullSnapshot` in both ports). */
const CASES: [string, string][] = [
  ['plain', ok('"retCode":0,"retMsg":"OK",')],
  ['retCode 0.0', ok('"retCode":0.0,')],
  ['retCode -0', ok('"retCode":-0,')],
  ['retCode 0e0', ok('"retCode":0e0,')],
  ['retCode 1e0', ok('"retCode":1e0,')],
  ['retCode string 0', ok('"retCode":"0",')],
  ['retCode null', ok('"retCode":null,')],
  ['retCode absent', ok('')],
  ['retCode true', ok('"retCode":true,')],
  ['retCode object', ok('"retCode":{"a":1},')],
  ['retCode empty array', ok('"retCode":[],')],
  ['retCode [0]', ok('"retCode":[0],')],
  ['retCode nested array', ok('"retCode":[1,[2,[3,null]],null,"x",{}],')],
  ['retCode 1.5', ok('"retCode":1.5,')],
  ['retCode 1e21', ok('"retCode":1e21,')],
  ['retCode 1.25e22', ok('"retCode":1.25e22,')],
  ['retCode 1e-7', ok('"retCode":1e-7,')],
  ['retCode 0.000001', ok('"retCode":0.000001,')],
  ['retCode 2^60', ok('"retCode":1152921504606846976,')],
  ['retCode 10001', '{"retCode":10001,"retMsg":"Invalid symbol"}'],
  ['retCode negative', '{"retCode":-3,"retMsg":"x"}'],
  ['retMsg number with retCode 0', ok('"retCode":0,"retMsg":7,')],
  ['retMsg number', '{"retCode":1,"retMsg":7}'],
  ['retMsg null', '{"retCode":1,"retMsg":null}'],
  ['retMsg object', '{"retCode":1,"retMsg":{"a":[1]}}'],
  ['retMsg array', '{"retCode":1,"retMsg":[1,"two",null,[3]]}'],
  ['retMsg false', '{"retCode":1,"retMsg":false}'],
  ['retMsg emoji long', `{"retCode":1,"retMsg":"${emoji.repeat(100)}"}`],
  ['retMsg emoji at the cut', `{"retCode":1,"retMsg":"${'a'.repeat(109)}${emoji}tail"}`],
  ['retMsg emoji before the cut', `{"retCode":1,"retMsg":"${'a'.repeat(108)}${emoji}tail"}`],
  ['retMsg long ascii', `{"retCode":1,"retMsg":"${'b'.repeat(300)}"}`],
  ['retMsg spaces then text past the cut', `{"retCode":1,"retMsg":"a${' '.repeat(200)}z"}`],
  ['retMsg trailing JS spaces', '{"retCode":1,"retMsg":"msg \\u00a0\\ufeff\\u2028\\u3000\\t\\n"}'],
  ['retMsg trailing NEL', '{"retCode":1,"retMsg":"msg\\u0085"}'],
  ['retMsg empty', '{"retCode":1,"retMsg":""}'],
  ['retMsg escapes', '{"retCode":1,"retMsg":"a\\"b\\\\c\\/d\\u00e9"}'],
  // Past the recorder's 512-character text cap: only whether ink was cut off may still matter.
  ['retMsg array past the cap', JSON.stringify({ retCode: 1, retMsg: Array(300).fill({}) })],
  ['retCode array past the cap', JSON.stringify({ retCode: Array(200).fill('xy'), retMsg: 'm' })],
  ['retMsg string, only spaces past the cap', JSON.stringify({ retCode: 1, retMsg: 'a' + ' '.repeat(700) })],
  ['retMsg string, ink past the cap', JSON.stringify({ retCode: 1, retMsg: 'a' + ' '.repeat(700) + 'z' })],
  ['retMsg array, only spaces past the cap', JSON.stringify({ retCode: 1, retMsg: ['a' + ' '.repeat(700)] })],
  ['retMsg array, ink past the cap', JSON.stringify({ retCode: 1, retMsg: ['a' + ' '.repeat(700), null] })],
  ['retMsg nested arrays past the cap', JSON.stringify({ retCode: 1, retMsg: [[' '.repeat(600)], 'z'] })],
  ['retMsg spaces only', JSON.stringify({ retCode: 1, retMsg: ' '.repeat(700) })],
  ['retCode spaces past the cap, then a message', JSON.stringify({ retCode: ['x' + ' '.repeat(700)], retMsg: 'm' })],
  ['result false with an error code', '{"retCode":10001,"retMsg":"Invalid symbol","result":false}'],
  ['result bad levels with an error code', '{"retCode":10001,"result":{"b":"x"}}'],
  ['result false', '{"retCode":0,"result":false}'],
  ['result array', '{"retCode":0,"result":[1,2]}'],
  ['result null', '{"retCode":0,"result":null}'],
  ['result string', '{"retCode":0,"result":"x"}'],
  ['result absent', '{"retCode":0}'],
  ['top-level array', `[0,null,${result('')}]`],
  ['top-level string', '"x"'],
  ['top-level number', '5'],
  ['top-level null', 'null'],
  ['symbol number', '{"retCode":0,"result":{"s":1,"u":1,"seq":1,"b":[],"a":[]}}'],
  ['symbol absent', '{"retCode":0,"result":{"u":1,"seq":1,"b":[],"a":[]}}'],
  ['another symbol with bad rows', '{"retCode":0,"result":{"s":"ETHUSDT","u":1,"seq":1,"b":[[1,2]],"a":[]}}'],
  ['symbol escaped', '{"retCode":0,"result":{"s":"BTC\\u0055SDT","u":1,"seq":1,"b":[["99","1"]],"a":[["101","1"]]}}'],
  ['no u with bad rows', '{"retCode":0,"result":{"s":"BTCUSDT","seq":1,"b":[[1,2]],"a":[]}}'],
  ['u string', '{"retCode":0,"result":{"s":"BTCUSDT","u":"12","seq":"0","b":[],"a":[]}}'],
  ['u negative string', '{"retCode":0,"result":{"s":"BTCUSDT","u":"-1","seq":1,"b":[],"a":[]}}'],
  ['u fraction', '{"retCode":0,"result":{"s":"BTCUSDT","u":1.5,"seq":1,"b":[],"a":[]}}'],
  ['u 2^53', '{"retCode":0,"result":{"s":"BTCUSDT","u":9007199254740992,"seq":1,"b":[],"a":[]}}'],
  ['u 2^53-1', '{"retCode":0,"result":{"s":"BTCUSDT","u":9007199254740991,"seq":1,"b":[],"a":[]}}'],
  ['u 17 digits', '{"retCode":0,"result":{"s":"BTCUSDT","u":"12345678901234567","seq":1,"b":[],"a":[]}}'],
  ['u 1e3, seq -0', '{"retCode":0,"result":{"s":"BTCUSDT","u":1e3,"seq":-0,"b":[],"a":[]}}'],
  ['u null', '{"retCode":0,"result":{"s":"BTCUSDT","u":null,"seq":1,"b":[],"a":[]}}'],
  ['price a number', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[[99,"1"]],"a":[]}}'],
  ['short row', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["99"]],"a":[]}}'],
  ['row an object', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[{"p":"99"}],"a":[]}}'],
  ['levels null', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":null,"a":[]}}'],
  ['levels absent', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"a":[]}}'],
  ['levels an object', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":{},"a":[]}}'],
  ['size 0', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["99","0"]],"a":[]}}'],
  ['price 0', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["0","1"]],"a":[]}}'],
  ['exponent', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["1e3","1"]],"a":[]}}'],
  ['leading zero', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["01","1"]],"a":[]}}'],
  ['bare fraction', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[[".5","1"]],"a":[]}}'],
  ['extra row elements', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["99","1","x",[1],{"a":2}]],"a":[["101.25","0.001",null]]}}'],
  ['a bad row after good ones', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["99","1"],["98","1"],["97",null]],"a":[]}}'],
  ['duplicate retCode, last 0', `{"retCode":1,"retCode":0,"result":${result('')}}`],
  ['duplicate retCode, last 1', `{"retCode":0,"retCode":1,"result":${result('')}}`],
  ['duplicate levels, last good', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[[1,2]],"b":[["99","1"]],"a":[]}}'],
  ['duplicate levels, last bad', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["99","1"]],"b":[[1,2]],"a":[]}}'],
  ['duplicate result, last good', `{"retCode":0,"result":false,"result":${result('')}}`],
  ['duplicate symbol', '{"retCode":0,"result":{"s":"BTCUSDT","s":"ETHUSDT","u":1,"seq":1,"b":[],"a":[]}}'],
  ['bids out of order', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["98","1"],["99","1"]],"a":[]}}'],
  ['bids repeated', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["99","1"],["99","2"]],"a":[]}}'],
  ['asks out of order', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[],"a":[["102","1"],["101","1"]]}}'],
  ['crossed', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["101","1"]],"a":[["101","1"]]}}'],
  ['one-sided', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[["99.5","1.25"]],"a":[]}}'],
  ['empty book', '{"retCode":0,"result":{"s":"BTCUSDT","u":1,"seq":1,"b":[],"a":[]}}'],
  ['unknown keys', '{"retCode":0,"time":1,"retExtInfo":{},"result":{"s":"BTCUSDT","u":1,"seq":1,"ts":"x","cts":2,"b":[["99","1"]],"a":[["101","1"]]}}'],
];

/** The page's answer as the fixture holds it: half of a UTF-16 pair becomes U+FFFD; prices as `String()`. */
function answer(text: string): string | { u: number; seq: number; b: [string, string][]; a: [string, string][] } {
  const out = parseFullSnapshot(JSON.parse(text), SYMBOL);
  if (typeof out === 'string') return out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
  const rows = (side: [number, number][]): [string, string][] => side.map(([p, q]) => [String(p), String(q)]);
  return { u: out.u, seq: out.seq, b: rows(out.b), a: rows(out.a) };
}

test('snapshot parity: the page\'s answers to odd snapshot answers are the fixture the recorder is held to', () => {
  const now = { symbol: SYMBOL, cases: CASES.map(([name, body]) => ({ name, body, expect: answer(body) })) };
  assert.equal(new Set(CASES.map(c => c[0])).size, CASES.length, 'case names are unique');
  if (process.env.HLM_WRITE_TRACE === '1') fs.writeFileSync(fixturePath, JSON.stringify(now, null, 1) + '\n');
  const kept = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as typeof now;
  // Through JSON, as the recorder reads it (a sequence of -0 is written 0).
  assert.deepEqual(kept, JSON.parse(JSON.stringify(now)), 'run with HLM_WRITE_TRACE=1 to rewrite the fixture, then copy it to the recorder');
  // A few answers stated outright, so a fixture written by a broken parser cannot pass.
  const by = new Map(now.cases.map(c => [c.name, c.expect]));
  assert.equal(by.get('retCode null'), 'retCode null');
  assert.equal(by.get('retCode absent'), 'retCode undefined');
  assert.equal(by.get('retCode object'), 'retCode [object Object]');
  assert.equal(by.get('result false with an error code'), 'retCode 10001 Invalid symbol');
  assert.equal(by.get('top-level array'), 'not an object');
  assert.equal(by.get('another symbol with bad rows'), 'another symbol');
  assert.equal(typeof by.get('retMsg number with retCode 0'), 'object');
  assert.equal(typeof by.get('duplicate retCode, last 0'), 'object');
  assert.equal((by.get('retMsg emoji long') as string).length, 120);
});
