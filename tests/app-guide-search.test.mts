import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS } from '../src/app/guide/content.ts';
import { blockPath, buildIndex, canSearch, entriesOf, fold, search, snippet, tokensOf, within, type Entry } from '../src/app/guide/search.ts';

const entry = (section: number, text: string, title = false, path = `${section}.0`): Entry => ({ section, path: title ? '' : path, title, text });
const small = buildIndex([
  entry(0, 'The footprint', true),
  entry(0, 'At every price inside the candle the footprint shows how much traded at the bid and at the ask.'),
  entry(1, 'Mirror: which side has more?', true),
  entry(1, 'Point at a price in the profile or the order book and the Mirror box says which side is bigger.'),
  entry(2, 'VWAP and anchors', true),
  entry(2, 'VWAP is the average price the market traded at, weighted by volume.'),
  entry(3, 'Café notes: Münchner Größe'),
  entry(4, '订单簿显示每个价格上等待的订单数量'),
  entry(5, 'Delta, CVD and who opened', true),
  entry(5, 'NL/NS estimates who opened and closed positions.'),
]);
const first = (query: string): number | undefined => search(small, query)[0]?.section;

test('folding drops case, accents and width, and remembers where every letter came from', () => {
  assert.equal(fold('Café Größe').text, 'cafe grosse');
  assert.equal(fold('ＶＷＡＰ').text, 'vwap', 'full-width letters');
  const f = fold('Zoé x');
  assert.equal(f.from[f.text.length], 'Zoé x'.length, 'the last position is the end of the original');
  assert.deepEqual(tokensOf('NL/NS  vwap!'), ['nl', 'ns', 'vwap']);
});

test('a word is found as it is, as a beginning, inside a word, with a typo, or as letters in order', () => {
  assert.equal(first('footprint'), 0, 'the word');
  assert.equal(first('footpr'), 0, 'a beginning, as it is typed');
  assert.equal(first('mirror'), 1);
  assert.equal(first('footpirnt'), 0, 'two letters swapped');
  assert.equal(first('mirorr'), 1, 'two letters swapped');
  assert.equal(first('vwapp'), 2, 'one letter too many');
  assert.equal(first('vwp'), 2, 'letters in order, first letter the word\'s own');
  assert.equal(first('CAFE'), 3, 'case and accents do not count');
  assert.equal(first('grosse'), 3, 'ß is read as ss');
  assert.equal(first('rint'), 0, 'inside a word');
  assert.equal(first('footprn'), 0, 'a typo of the beginning of a longer word');
  assert.equal(search(small, 'xylophone').length, 0);
});

test('every typed word has to be there, and one letter is not a question', () => {
  assert.equal(first('mirror hover'), 1, 'a word found nowhere in the guide is dropped, the others are looked for');
  assert.deepEqual(search(small, 'xylophone zeppelin'), []);
  assert.equal(first('cvd closed'), 5, 'words in different texts of one section find the section');
  assert.equal(first('what is vwap'), 2, 'question words are not looked for');
  assert.equal(first('mirror bigger'), 1);
  assert.equal(first('who opened'), 5);
  assert.equal(first('nl/ns'), 5, 'a word with a slash is its two words');
  assert.deepEqual(search(small, 'a'), []);
  assert.deepEqual(search(small, '   '), []);
  assert.deepEqual([canSearch('a'), canSearch(' / '), canSearch('vw'), canSearch('订')], [false, false, true, true]);
});

test('Chinese, Japanese and Korean are looked for as written, anywhere in the text, with no typos', () => {
  assert.equal(first('订单'), 4);
  assert.equal(first('订单簿'), 4);
  assert.equal(first('簿'), 4, 'one character is a word there');
  assert.equal(first('订簿'), undefined);
});

test('a title counts for more than a mention, and a section is answered once, by its best text', () => {
  const found = search(small, 'footprint');
  assert.equal(found.filter(f => f.section === 0).length, 1);
  assert.equal(found[0]!.title, true, 'the title is the best text');
  assert.ok(found[0]!.ranges.length === 1 && found[0]!.text.slice(...found[0]!.ranges[0]!).toLowerCase() === 'footprint');
  assert.equal(search(small, 'price').length, 3, 'three sections say it');
  assert.equal(search(small, 'price', 2).length, 2, 'at most the limit');
});

test('typo distance counts a swap of neighbours once and gives up past the limit', () => {
  assert.equal(within('mirror', 'mirror', 1), 0);
  assert.equal(within('mirror', 'mirorr', 1), 1);
  assert.equal(within('mirror', 'mirr', 1), null);
  assert.equal(within('abc', 'abcdef', 2), null, 'the lengths already differ by more');
});

test('a snippet is a stretch around the match, cut at a word, with the match marked', () => {
  const text = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega';
  const at = text.indexOf('sigma');
  const pieces = snippet(text, [[at, at + 5]], 60);
  assert.equal(pieces.filter(p => p.mark).map(p => p.text).join(''), 'sigma');
  assert.ok(pieces[0]!.text.startsWith('…'), 'cut at the start');
  assert.ok(pieces[pieces.length - 1]!.text.endsWith('…'), 'cut at the end');
  assert.ok(pieces.map(p => p.text).join('').length < 90);
  assert.deepEqual(snippet('short text', [[0, 5]]).map(p => [p.text, p.mark]), [['short', true], [' text', false]]);
  assert.deepEqual(snippet('short text', []).map(p => p.mark), [false]);
});

test('the real guide answers the questions a visitor types, in English', () => {
  const index = buildIndex(entriesOf(SECTIONS));
  const ids = (query: string): string[] => search(index, query).map(f => SECTIONS[f.section]!.id);
  assert.equal(ids('vwap')[0], 'vwap');
  assert.equal(ids('replay')[0], 'goto');
  assert.equal(ids('go to')[0], 'goto');
  assert.equal(ids('drawing')[0], 'drawing');
  assert.equal(ids('funding')[0], 'funding');
  assert.equal(ids('long short')[0], 'ls');
  assert.equal(ids('footprnt')[0], 'footprint');
  assert.equal(ids('scripts')[0], 'scripts');
  assert.equal(ids('screenshot')[0], 'tools');
  assert.equal(ids('key levels')[0], 'key-levels');
  assert.equal(ids('anchor').slice(0, 3).includes('vwap'), true);
  assert.equal(ids('cvd').slice(0, 3).includes('delta'), true);
  assert.equal(ids('nl/ns').slice(0, 3).includes('delta'), true);
  assert.equal(ids('history').slice(0, 2).includes('recording'), true);
  assert.equal(ids('mirror')[0], 'mirror');
  assert.deepEqual(ids('qwertyuiop'), []);
});

test('an entry is found where the rendered guide has it', () => {
  const entries = entriesOf(SECTIONS);
  const paths = entries.filter(e => !e.title).map(e => e.path);
  assert.equal(new Set(paths).size, paths.length, 'every text has a place of its own');
  assert.equal(blockPath(2, 3), '2.3');
  assert.equal(blockPath(2, 3, 1), '2.3.1');
  assert.equal(entries.filter(e => e.title).length, SECTIONS.length);
  assert.ok(entries.every(e => !/\*\*|\[\[|`/.test(e.text)), 'markup is taken out');
});

test('a match is marked where it is in the original, not where it is in the folded text', () => {
  const index = buildIndex([entry(0, 'ﬁnance ratio'), entry(1, 'Ｗｉｄｅ ＶＷＡＰ here'), entry(2, '한 줄로 나열합니다 호가창 보기')]);
  const marked = (query: string): string => { const f = search(index, query)[0]!; return f.ranges.map(([a, b]) => f.text.slice(a, b)).join('|'); };
  assert.equal(marked('ratio'), 'ratio', 'a ligature before it folds to two letters');
  assert.equal(marked('ance'), 'ance');
  assert.equal(marked('vwap'), 'ＶＷＡＰ', 'full-width letters');
  assert.equal(marked('하'), '한', 'a Hangul syllable is several letters and is marked whole');
  assert.ok(search(index, '호가참').length === 1, 'a typo in Korean is forgiven letter by letter');
});

test('numbers are found as they are, with or without their commas, and never as a typo', () => {
  const index = buildIndex([entry(0, 'Scripts read 10,000 of the candles, 2,000 on a phone, up to 100,000.')]);
  for (const query of ['10000', '10,000', '2000', '100000']) assert.equal(search(index, query).length, 1, query);
  for (const query of ['5000', '3000', '000']) assert.equal(search(index, query).length, 0, query);
});

test('the voiced marks of kana tell letters apart, and ß and ı are folded', () => {
  const index = buildIndex([entry(0, 'がくしゅう'), entry(1, 'Straße laştırı')]);
  assert.equal(first2(index, 'がく'), 0);
  assert.equal(first2(index, 'かく'), undefined, 'か is not が');
  assert.equal(first2(index, 'strasse'), 1);
  assert.equal(first2(index, 'lastiri'), 1);
  function first2(ix: ReturnType<typeof buildIndex>, query: string): number | undefined { return search(ix, query)[0]?.section; }
});

test('a title word counts for more than the same word in a text, but a typo of one does not', () => {
  const index = buildIndex([entry(0, 'The volume profile bars', false), entry(1, 'Profile', true), entry(2, 'Profil', true), entry(3, 'Plain text with profile once', false)]);
  assert.equal(search(index, 'profile')[0]!.section, 1, 'the title first although a text came earlier');
  const typo = buildIndex([entry(0, 'Delta is here in the text', false), entry(1, 'Delto', true)]);
  assert.equal(search(typo, 'delta')[0]!.section, 0, 'a typo of a title word has no title weight');
});

test('the real guide answers a question, a few words from one section, and a title before a mention', () => {
  const index = buildIndex(entriesOf(SECTIONS));
  const ids = (query: string): string[] => search(index, query).map(f => SECTIONS[f.section]!.id);
  assert.equal(ids('save layout')[0], 'layouts');
  assert.equal(ids('bar stats csv')[0], 'bar-stats');
  assert.equal(ids('what is vwap')[0], 'vwap');
  assert.ok(ids('how do I zoom').slice(0, 3).includes('moving'));
  assert.equal(ids('profile')[0], 'profile', 'the title that is only the word, before a longer one');
  assert.ok(['start', 'tools'].includes(ids('tour')[0]!) && !ids('tour').slice(0, 3).includes('scripts'), 'a typo of a title word (your) does not lead');
  assert.ok(search(index, 'delta').every(f => f.text.toLowerCase().includes('delta')), 'the weak tail of near words (detail, covered) is cut');
});
