import { t, tn } from '../i18n.ts';
import { price } from '../format.ts';
import { PRICE_QUERY_BARS } from '../../shared/price-history.ts';
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

export function warningText(w: Warning): string {
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
      // "line|window|candles read", from the run (engine.ts); the reference shows it with X for each. Each count is said with its noun.
      const parts = what.split('|'), known = parts.length === 3 && parts.every(p => p !== '' && Number.isFinite(Number(p)));
      const candles = (v: number): string => tn(v, '{n} candle', '{n} candles', { n: price(v, 1) });
      const count = (k: number): string => known ? candles(Number(parts[k])) : 'X';
      const say = { line: known ? String(Number(parts[0])) : 'X', n: count(1), have: count(2), max: candles(PRICE_QUERY_BARS) };
      // A window longer than any view gives a script: zooming out cannot fill it, so it is not offered.
      return known && Number(parts[1]) > PRICE_QUERY_BARS
        ? t('Line {line}: a window of {n} never fills here: a script reads at most {max} of the chart\'s timeframe, and this chart gives it {have}.', say)
        : t('Line {line}: a window of {n} never fills here, as the chart gives this script {have}. Zoom out for more, up to {max}, or choose a longer timeframe.', say);
    }
    default: return w.code;
  }
}
