import { t, tn } from '../i18n.ts';
import { price } from '../format.ts';
import { MOST_SCRIPT_BARS } from './bars.ts';
import type { ScriptError } from './lang/lexer.ts';
import type { Warning } from './protocol.ts';

/** What an error or a warning of a script says, in the page's language, with where it is. */
export function errorText(e: ScriptError): string {
  const what = e.detail ?? '';
  let text: string;
  switch (e.code) {
    case 'unexpected-end': text = t('The script ends before this is complete.'); break;
    case 'expected': text = t('Expected {what} here.', { what }); break;
    case 'expected-end': text = t('Two statements on one line: put a line break or a semicolon between them.'); break;
    case 'expected-name': text = t('A name was expected here.'); break;
    case 'unterminated-string': text = t('A text is not closed with its quote.'); break;
    case 'unterminated-comment': text = t('A comment is not closed.'); break;
    case 'unexpected-char': text = t('This character cannot be read: {what}', { what }); break;
    case 'bad-number': text = t('This number cannot be read.'); break;
    case 'unexpected': text = t('Unexpected {what} here.', { what }); break;
    case 'bad-assignment': text = t('Only a name, a member or an element can be set.'); break;
    case 'unsupported': text = t('{what} is not part of the script language.', { what }); break;
    case 'too-deep': text = t('Nested too deeply.'); break;
    case 'too-many-sources': text = t('Too many different sets of markets: at most 24.'); break;
    case 'too-many-plots': text = t('Too many plots: at most 64.'); break;
    case 'unknown-name': text = t('{what} is not defined.', { what }); break;
    case 'not-callable': text = what ? t('{what} is not a function.', { what }) : t('This is not a function.'); break;
    case 'no-member': text = t('Cannot read {what} of nothing (undefined or null).', { what }); break;
    case 'read-only': text = t('{what} cannot be set.', { what }); break;
    case 'const': text = t('{what} is a constant and cannot be set.', { what }); break;
    case 'redeclared': text = t('{what} is declared twice.', { what }); break;
    case 'bad-jump': text = t('A break, continue or return outside the loop or function it belongs to.'); break;
    case 'budget': text = t('Stopped: the script took too many steps (a loop that never ends?).'); break;
    case 'too-slow': text = t('Stopped: the script took too long.'); break;
    case 'too-large': text = t('Stopped: an array or a text grew too large.'); break;
    case 'timeout': text = t('Stopped: the run took too long and was ended.'); break;
    case 'worker-failed': case 'internal': case 'no-answer': text = t('The scripts could not be run here.'); break;
    case 'newer-api': text = t('This script was written for a newer version of the script language: update the page to run it.'); break;
    default: text = e.code;
  }
  return e.line > 0 ? t('Line {line}, column {col}: {text}', { line: e.line, col: e.col, text }) : text;
}

/** A run's warning in words; `reads`: how many of the chart's candles the scripts read now (`script/bars.ts`), for the long-window one. */
export function warningText(w: Warning, reads?: number): string {
  const what = w.detail ?? '';
  switch (w.code) {
    case 'no-counts': return t('Trade counts (cbuy, csell) are not recorded here: they read NaN.');
    case 'unknown-reference': return t('{what} names no series here: it reads nothing.', { what });
    case 'unsupported-member': return t('{what} is not available here: it reads nothing.', { what });
    case 'no-plots': return t('The script draws nothing: add a plot such as line(...) or histogram(...).');
    case 'no-markets': return t('No market on the page matches {what}: it reads 0.', { what });
    case 'unset-option': return t('Option {what} is not set: give it a value below.', { what });
    case 'unread-source': return t('A source(...) names its markets with something only the run can work out: it reads 0. Name them with a word, an option or options.name.');
    case 'liquidations-cut': return t('Some days held more liquidations than the source answers: the smallest are missing from lbuy and lsell.');
    case 'long-window': {
      // 'line|asked|window|candles read', from the run (engine.ts): the window asked, the one it has (at most the longest a window can be,
      // `MAX_WINDOW`) and the candles; 'line|window|candles' from a run before the two were told apart. `reads`: how many candles the scripts
      // read now (the Scripts panel's Candles scripts read; the reference, which has none, shows X for each count, as for an unknown detail).
      const parts = what.split('|'), known = (parts.length === 3 || parts.length === 4) && parts.every(p => p !== '' && Number.isFinite(Number(p)));
      const four = parts.length === 4, at = four ? 2 : 1, num = (k: number): number => Number(parts[k]);
      const candles = (v: number): string => tn(v, '{n} candle', '{n} candles', { n: price(v, 1) });
      const n = known ? num(at) : NaN, have = known ? num(at + 1) : NaN, asked = known && four ? num(1) : n;
      const say = { line: known ? String(num(0)) : 'X', asked: known ? candles(asked) : 'X', n: known ? candles(n) : 'X', have: known ? candles(have) : 'X', max: known && reads !== undefined ? candles(reads) : 'X', most: candles(MOST_SCRIPT_BARS) };
      // Asked longer than any window can be: it counts back the longest, and says so whether or not that fills.
      const capped = known && asked > n ? t('Line {line}: {asked} is more than a window can hold, so it uses the last {n}.', say) : '';
      if (known && !(n > have)) return capped;
      // Longer than the scripts read: more can be chosen, up to the most, which is the longest a window can be (so a window is never longer than
      // the most they can read); within it, the chart gives fewer (a shorter history, or one still being read).
      const unfilled = known && reads !== undefined && n <= reads
        ? t('Line {line}: this needs {n}, but this chart gives scripts only {have} of the {max} they read.', say)
        : t('Line {line}: this needs {n}, but scripts read only {max}. Raise Candles per script (up to {most}) or use a longer timeframe.', say);
      return capped ? `${capped} ${unfilled}` : unfilled;
    }
    default: return w.code;
  }
}
