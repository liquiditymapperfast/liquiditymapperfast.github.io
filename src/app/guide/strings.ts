import type { Section } from './content.ts';

/**
 * Every text the guide says that a language pack has to cover: the sections (titles, paragraphs, list items, notes, captions, both sides of a
 * key row) and the words the pictures draw (every literal handed to `tg(...)` in `figures.ts`). Pure, so the test and the pack template read
 * the same list. `figuresSource` is the text of `figures.ts`.
 */
export function guideStrings(sections: readonly Section[], figuresSource: string): string[] {
  const out = new Set<string>();
  for (const section of sections) {
    out.add(section.title);
    for (const block of section.blocks) {
      if (block.t === 'p' || block.t === 'note') out.add(block.text);
      else if (block.t === 'list') for (const item of block.items) out.add(item);
      else if (block.t === 'fig') out.add(block.caption);
      else for (const [keys, does] of block.rows) { out.add(keys); out.add(does); }
    }
  }
  for (const text of figureStrings(figuresSource)) out.add(text);
  return [...out];
}

/** The literal first arguments of `tg('...')` (single-quoted, a backslash escapes the next character) in the source of the figures. */
export function figureStrings(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\btg\(\s*'((?:\\.|[^'\\])*)'/g)) found.push(match[1]!.replace(/\\(.)/g, '$1'));
  return found;
}

/** The markup of a text that a translation must keep: bold and italic marks, code spans, key caps, and the `{placeholders}`. */
export function markupOf(text: string): { bold: number; code: number; italic: number; keys: string[]; placeholders: string[] } {
  const keys = [...text.matchAll(/\[\[(.+?)\]\]/g)].map(m => m[1]!);
  const rest = text.replace(/\[\[.+?\]\]/g, '');
  return {
    bold: (rest.match(/\*\*/g) ?? []).length,
    code: (rest.match(/`/g) ?? []).length,
    italic: (rest.replace(/\*\*/g, '').match(/\*/g) ?? []).length,
    keys,
    placeholders: [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort(),
  };
}
