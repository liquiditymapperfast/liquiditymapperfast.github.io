import type { Section } from './content.ts';
import { plain } from './markup.ts';

/**
 * Searching the guide: a small matcher over the guide's own text, in the page's language, with no dependency. Plain code with nothing to load,
 * so tests import it; `guide.ts` builds the entries from what it renders and draws the answer.
 *
 * What it does, in the order a typed word is tried against each word of a text:
 * - the word itself, then a word that begins with it, then a word that holds it (three letters or more);
 * - a typo: one letter wrong, missing, extra or swapped in a word of four to seven letters, two in a longer one, also against the beginning
 *   of a longer word (so `footpr` finds footprint while it is still being typed);
 * - letters in order inside one word, the first letter being the word's own (`vwp` finds VWAP, `dlt` delta).
 * A number is found as it is or as the beginning of a longer one, never with a typo, and `10,000` and `10000` are the same.
 * Case, accents and the width of characters do not count (ß is ss, ı is i; the voiced marks of kana do count). Chinese and Japanese have no
 * spaces between words, so a typed word there is looked for as it is, anywhere in the text, with no room for typos. Korean is matched letter by
 * letter (a syllable still being typed is its letters so far), so it is found by its beginning and forgives a typo like any alphabet.
 *
 * Which texts answer: every typed word must be in one text (a paragraph, a list item, a row of keys or a title); failing that, every word
 * somewhere in one section (worth less); failing that, the words that are anywhere in the guide at all, so a question like "how do I zoom"
 * is answered by its zoom. Question words (what, how, the) are dropped while a word of substance is left. A section is answered by its best
 * text; a match in a title counts for most when it is a real one (a typo of a title word does not get the title's weight).
 */
export interface Entry {
  section: number;
  /** Where the text stands in the rendered guide: `section.block` or `section.block.item` (`blockPath`); a title has none. */
  path: string;
  title: boolean;
  text: string;
}

/** One section's answer: its best text, how well it matched, and where in that text (original coordinates). */
export interface Found { section: number; path: string; title: boolean; text: string; score: number; ranges: [number, number][] }

/** The id the rendered guide gives a block (`data-b`), and an item of a list or a row of a key table. */
export const blockPath = (section: number, block: number, item?: number): string => item === undefined ? `${section}.${block}` : `${section}.${block}.${item}`;

/** Every text of the guide as one entry each, in reading order, said through `say` (the page's language) with its markup taken out. */
export function entriesOf(sections: readonly Section[], say: (text: string) => string = text => text): Entry[] {
  const out: Entry[] = [];
  sections.forEach((section, s) => {
    out.push({ section: s, path: '', title: true, text: plain(say(section.title)) });
    section.blocks.forEach((block, b) => {
      if (block.t === 'p' || block.t === 'note') out.push({ section: s, path: blockPath(s, b), title: false, text: plain(say(block.text)) });
      else if (block.t === 'fig') out.push({ section: s, path: blockPath(s, b), title: false, text: plain(say(block.caption)) });
      else if (block.t === 'list') block.items.forEach((item, i) => out.push({ section: s, path: blockPath(s, b, i), title: false, text: plain(say(item)) }));
      else block.rows.forEach(([keys, does], i) => out.push({ section: s, path: blockPath(s, b, i), title: false, text: `${plain(say(keys))} ${plain(say(does))}` }));
    });
  });
  return out;
}

/** Chinese, Japanese and Korean syllables: no spaces between words. (Korean is split into letters by `fold`, so it takes the word path too.) */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/u;
/** A word: letters and digits (a digit group joined by commas, `10,000`, is one), with the voiced marks of kana kept in it. */
const WORD = /[\p{L}\p{N}゙゚]+(?:,\p{N}{3}(?!\p{N}))*/gu;
/** Words that ask rather than look for: dropped from a query while it has a word of substance. */
const QUESTION = new Set(['what', 'whats', 'is', 'are', 'how', 'do', 'does', 'did', 'can', 'to', 'the', 'an', 'of', 'in', 'on', 'for', 'my', 'me', 'it', 'you', 'and', 'or', 'where', 'which', 'why', 'with', 'be', 'get', 'use']);

interface Folded { text: string; /** For each UTF-16 unit of `text`, where its character began in the original; the last is the original's length. */ from: number[] }

/** Case, accents and width folded away, remembering where every folded letter came from so a match can be marked in the original. */
export function fold(original: string): Folded {
  let text = '', at = 0;
  const from: number[] = [];
  for (const ch of original) {
    const piece = ch.normalize('NFKD').replace(/(?![゙゚])\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/ı/g, 'i');
    for (let k = 0; k < piece.length; k++) from.push(at);
    text += piece; at += ch.length;
  }
  from.push(original.length);
  return { text, from };
}

interface Word { start: number; end: number; text: string }
export interface Indexed { entry: Entry; folded: Folded; words: Word[] }

/** The words of a folded text: where each stands, and its letters without the commas of a digit group. */
function wordsOf(text: string): Word[] {
  return [...text.matchAll(WORD)].map(m => ({ start: m.index!, end: m.index! + m[0].length, text: m[0].replace(/,/g, '') }));
}

/** The entries ready to be searched (folded once). */
export function buildIndex(entries: readonly Entry[]): Indexed[] {
  return entries.map(entry => { const folded = fold(entry.text); return { entry, folded, words: wordsOf(folded.text) }; });
}

/** The typed words: letters and digits in runs, folded (`NL/NS` is two words, as it is in the text). */
export function tokensOf(query: string): string[] {
  return wordsOf(fold(query).text).map(w => w.text);
}

/** Edit distance with a swap of two neighbours counted as one change, or null when it is more than `limit`. */
export function within(a: string, b: string, limit: number): number | null {
  if (Math.abs(a.length - b.length) > limit) return null;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) { rows.push(new Array<number>(b.length + 1).fill(0)); rows[i]![0] = i; }
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let low = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = d; if (d < low) low = d;
    }
    if (low > limit) return null;
  }
  const d = rows[a.length]![b.length]!;
  return d <= limit ? d : null;
}

/** How compactly the letters of `token` stand in order in `word` (1: together; less: spread), or null when they do not, or the first letters differ. */
function subsequence(word: string, token: string): number | null {
  if (word[0] !== token[0]) return null;
  let j = 0, first = -1, last = -1;
  for (let i = 0; i < word.length && j < token.length; i++) if (word[i] === token[j]) { if (first < 0) first = i; last = i; j++; }
  return j < token.length ? null : token.length / (last - first + 1);
}

interface Match { score: number; start: number; end: number }

/** The score from which a match counts as a real one of the word (the word, its beginning, a part of it), not a guess at a typo or at letters. */
const REAL = 0.7;

function matchToken(token: string, ix: Indexed): Match | null {
  if (CJK.test(token)) { const at = ix.folded.text.indexOf(token); return at < 0 ? null : { score: 1, start: at, end: at + token.length }; }
  let best: Match | null = null;
  const take = (score: number, start: number, end: number): void => { if (!best || score > best.score) best = { score, start, end }; };
  const L = token.length, tolerance = L >= 8 ? 2 : 1, digits = /^\p{N}+$/u.test(token);
  for (const w of ix.words) {
    const word = w.text;
    if (word === token) { take(1, w.start, w.end); continue; }
    if (word.startsWith(token)) { take(L < 2 ? 0.55 : 0.9, w.start, w.start + L); continue; }
    if (L < 2 || digits) continue; // a number is the number or the beginning of one
    if (L >= 3) { const at = word.indexOf(token); if (at > 0) { take(REAL, w.start + at, w.start + at + L); continue; } }
    if (L >= 4) {
      const d = within(word, token, tolerance);
      if (d !== null) { take(0.62 - 0.1 * d, w.start, w.end); continue; }
      let dp: number | null = null;
      for (let n = L - 1; n <= L + 1 && dp === null; n++) if (n < word.length) dp = within(word.slice(0, n), token, tolerance);
      if (dp !== null) { take(0.55 - 0.1 * dp, w.start, w.start + L); continue; }
    }
    if (L >= 3 && L <= word.length) { const compact = subsequence(word, token); if (compact !== null) take(0.3 + 0.2 * compact, w.start, w.end); }
  }
  return best;
}

/** The typed words worth looking for: two letters or more (one is enough in Chinese and Japanese, where a character is a word). */
const worth = (query: string): string[] => tokensOf(query).filter(t => t.length >= 2 || CJK.test(t));

/** Whether `query` has anything to look for yet: the contents list stays on show until it has. */
export const canSearch = (query: string): boolean => worth(query).length > 0;

/** A text's match for each typed word (null where it has none), worked out once per word and text. */
type Matches = (Match | null)[][];

/** The sections answering every typed word, from `matches[token][entry]`: a text with all of them, else a section with all of them. */
function answer(index: readonly Indexed[], matches: Matches, factor: number): Found[] {
  const tokens = matches.length, strict = new Map<number, Found>(), extra = new Map<number, number>();
  // Per section and word, its best text: what a section answers when no one text has every word.
  const spread = new Map<number, { score: number; entry: number; start: number; end: number }[]>();
  index.forEach((ix, e) => {
    const section = ix.entry.section;
    let total = 0, all = true; const ranges: [number, number][] = [];
    for (let t = 0; t < tokens; t++) {
      const m = matches[t]![e];
      if (!m) { all = false; continue; }
      // A title's weight goes to a real match of a word, not to a typo or letters in order.
      const weighted = ix.entry.title && m.score >= REAL ? m.score * 1.8 : m.score;
      total += weighted;
      const rows = spread.get(section) ?? Array.from({ length: tokens }, () => ({ score: 0, entry: -1, start: 0, end: 0 }));
      if (weighted > rows[t]!.score) rows[t] = { score: weighted, entry: e, start: m.start, end: m.end };
      spread.set(section, rows);
      ranges.push([ix.folded.from[m.start]!, roundUp(ix.folded.from, m.end)]);
    }
    if (!all) return;
    extra.set(section, (extra.get(section) ?? 0) + 1);
    const titleCover = ix.entry.title ? 0.85 + 0.15 * Math.min(1, tokens / Math.max(1, ix.words.length)) : 1;
    const score = (total / tokens) * titleCover, held = strict.get(section);
    if (!held || score > held.score) strict.set(section, { section, path: ix.entry.path, title: ix.entry.title, text: ix.entry.text, score, ranges: ranges.sort((a, b) => a[0] - b[0]) });
  });
  const found: Found[] = [...strict.values()].map(f => ({ ...f, score: (f.title ? f.score : f.score + Math.min(0.1, 0.05 * ((extra.get(f.section) ?? 1) - 1))) * factor }));
  for (const [section, rows] of spread) {
    if (strict.has(section) || rows.some(r => r.entry < 0)) continue;
    // Every word is somewhere in the section: it answers with the text of its strongest word, the other words marked where they are in it.
    const lead = rows.reduce((a, b) => (b.score > a.score ? b : a)), ix = index[lead.entry]!;
    const ranges: [number, number][] = rows.filter(r => r.entry === lead.entry).map(r => [ix.folded.from[r.start]!, roundUp(ix.folded.from, r.end)]);
    found.push({ section, path: ix.entry.path, title: ix.entry.title, text: ix.entry.text, score: (rows.reduce((n, r) => n + r.score, 0) / tokens) * 0.6 * factor, ranges: ranges.sort((a, b) => a[0] - b[0]) });
  }
  return found;
}

/** The original position at the end of a match: a match ending inside a character that folded to several letters (a Hangul syllable) takes the whole of it. */
function roundUp(from: readonly number[], end: number): number {
  let e = end;
  while (e < from.length - 1 && from[e] === from[e - 1]) e++;
  return from[e]!;
}

/** The sections that answer `query`, best first, at most `limit`; none for a query with nothing to look for. */
export function search(index: readonly Indexed[], query: string, limit = 10): Found[] {
  const typed = worth(query);
  if (!typed.length) return [];
  const asked = typed.filter(t => !QUESTION.has(t)), tokens = asked.length ? asked : typed;
  const matches: Matches = tokens.map(token => index.map(ix => matchToken(token, ix)));
  let found = answer(index, matches, 1);
  if (!found.length && tokens.length > 1) {
    // Some words are nowhere in the guide at all: look for the others.
    const there = matches.filter(row => row.some(Boolean));
    if (there.length && there.length < tokens.length) found = answer(index, there, 0.5);
  }
  found.sort((a, b) => b.score - a.score || a.section - b.section);
  const top = found[0]?.score ?? 0;
  return found.filter(f => f.score >= top * 0.6).slice(0, limit);
}

/** A stretch of a text, marked or not: what a result is drawn from. */
export interface Piece { text: string; mark: boolean }

/** About `width` characters of `text` around its first marked range, with an ellipsis where it is cut, as pieces to draw (no markup is built here). */
export function snippet(text: string, ranges: readonly [number, number][], width = 130): Piece[] {
  const valid = ranges.filter(([a, b]) => b > a && a >= 0 && b <= text.length).sort((x, y) => x[0] - y[0]);
  let from = 0;
  if (valid.length && valid[0]![0] > 36) { from = valid[0]![0] - 36; const space = text.indexOf(' ', from); if (space >= 0 && space < valid[0]![0]) from = space + 1; }
  let to = Math.min(text.length, from + width);
  if (to < text.length) { const space = text.lastIndexOf(' ', to); if (space > from + width * 0.6) to = space; }
  const pieces: Piece[] = [];
  if (from > 0) pieces.push({ text: '… ', mark: false });
  let cursor = from;
  for (const [a, b] of valid) {
    if (a >= to) break;
    const start = Math.max(a, cursor), end = Math.min(b, to);
    if (end <= start) continue;
    if (start > cursor) pieces.push({ text: text.slice(cursor, start), mark: false });
    pieces.push({ text: text.slice(start, end), mark: true }); cursor = end;
  }
  if (cursor < to) pieces.push({ text: text.slice(cursor, to), mark: false });
  if (to < text.length) pieces.push({ text: ' …', mark: false });
  return pieces;
}
