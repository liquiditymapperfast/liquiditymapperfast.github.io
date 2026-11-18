/**
 * `text` as it is when it fits `max` px, else its longest start that fits with an ellipsis after it. `measure` is a canvas context's text width
 * in the font it is about to draw with; the cut is found by halving, so a long text costs a handful of measurements, not one per letter.
 */
export function fitText(measure: (text: string) => number, text: string, max: number): string {
  if (!text || measure(text) <= max) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (measure(`${text.slice(0, mid).trimEnd()}…`) <= max) low = mid; else high = mid - 1;
  }
  return low > 0 ? `${text.slice(0, low).trimEnd()}…` : '…';
}

/**
 * `text` broken into lines no wider than `max` px, at spaces; a word wider than a line (or a text without spaces, as Chinese and Japanese are
 * written) is broken between characters. At most `maxLines`, the last ending in an ellipsis where the text goes on.
 */
export function wrapText(measure: (text: string) => number, text: string, max: number, maxLines = Infinity): string[] {
  const lines: string[] = [];
  let line = '';
  const push = (): void => { if (line) lines.push(line); line = ''; };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= max) { line = next; continue; }
    push();
    if (measure(word) <= max) { line = word; continue; }
    // Too wide for a line of its own: as many characters as fit, line after line.
    for (const ch of word) { if (line && measure(line + ch) > max) push(); line += ch; }
  }
  push();
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fitText(measure, `${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, max);
  return kept;
}
