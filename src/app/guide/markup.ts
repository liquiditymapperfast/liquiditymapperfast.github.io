/** The guide's inline markup: `**bold**`, `*italic*`, `code` and `[[Key]]` (a keyboard key). Anything else is plain text; nothing is ever treated as HTML. */
export type Inline = { kind: 'text' | 'b' | 'i' | 'code' | 'kbd'; text: string };

const PATTERN = /\*\*(.+?)\*\*|\[\[(.+?)\]\]|`(.+?)`|\*(.+?)\*/g;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of source.matchAll(PATTERN)) {
    if (match.index > last) out.push({ kind: 'text', text: source.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ kind: 'b', text: match[1] });
    else if (match[2] !== undefined) out.push({ kind: 'kbd', text: match[2] });
    else if (match[3] !== undefined) out.push({ kind: 'code', text: match[3] });
    else out.push({ kind: 'i', text: match[4]! });
    last = match.index + match[0].length;
  }
  if (last < source.length) out.push({ kind: 'text', text: source.slice(last) });
  return out;
}

/** The text with the markup removed (for the table of contents, search and tests). */
export const plain = (source: string): string => parseInline(source).map(part => part.text).join('');
