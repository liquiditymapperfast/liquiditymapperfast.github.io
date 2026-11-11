/// <reference types="vite/client" />
import { el } from '../dom.ts';
import { compactBar, isCoarse } from '../device.ts';
import { makeDraggable } from '../drag.ts';
import { SECTIONS, readingMinutes, type Block, type Section } from './content.ts';
import { createFigure } from './figures.ts';
import { parseInline } from './markup.ts';
import { blockPath, buildIndex, canSearch, entriesOf, search, snippet, type Found, type Piece } from './search.ts';
import { language, t } from '../i18n.ts';
import { setGuideWords, tg } from './words.ts';
import { takeTour } from '../help.ts';

/** The guide's words in each language, each fetched only when the guide opens in that language (`i18n/<code>.json`, English being the text itself). */
const packs = import.meta.glob<Record<string, string>>('./i18n/*.json', { import: 'default' });

/**
 * The guide: a modal with the table of contents on the left and the text on the right, opened by the Guide button, by a "?" panel's link
 * (`#guide/<section>`), or by that address. It is loaded on demand. Figures animate only while they are on screen and stop with the guide.
 * A search box above the contents list answers in its place while something is typed (`search.ts`); on a narrow window, where the contents
 * list is the picker in the title bar, the answer drops over the text.
 */
let open: { dialog: HTMLDialogElement; scrollTo(id: string): void; close(): void } | null = null;
let opening = false;
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrow = (): boolean => typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches;

function inline(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const part of parseInline(source)) {
    if (part.kind === 'text') fragment.append(part.text);
    else fragment.append(el(part.kind === 'b' ? 'strong' : part.kind === 'i' ? 'em' : part.kind === 'code' ? 'code' : 'kbd', { textContent: part.text }));
  }
  return fragment;
}

/** Fetch the guide's words for the page's language; a language file that cannot be fetched leaves the guide in English rather than not opening. */
async function loadWords(): Promise<void> {
  const code = language(), load = code === 'en' ? undefined : packs[`./i18n/${code}.json`];
  if (!load) { setGuideWords({}); return; }
  try { setGuideWords(await load()); } catch (error) { console.error(`The guide's ${code} words could not be loaded; the guide stays in English.`, error); setGuideWords({}); }
}

/** Every block, list item and key row carries where it stands (`data-b`, `search.ts`'s `blockPath`), so a search result can take the reader to it. */
function renderBlock(block: Block, figures: { dispose(): void }[], at: (item?: number) => string): HTMLElement {
  switch (block.t) {
    case 'p': { const p = el('p'); p.dataset.b = at(); p.append(inline(tg(block.text))); return p; }
    case 'list': { const ul = el('ul'); block.items.forEach((item, i) => { const li = el('li'); li.dataset.b = at(i); li.append(inline(tg(item))); ul.append(li); }); return ul; }
    case 'note': { const n = el('aside', { class: `note ${block.kind ?? 'tip'}` }); n.dataset.b = at(); n.append(el('b', { textContent: block.kind === 'warn' ? t('Keep in mind') : t('Tip') }), inline(tg(block.text))); return n; }
    case 'fig': { const f = createFigure(block.id, tg(block.caption)); figures.push(f); f.root.dataset.b = at(); return f.root; }
    case 'keys': {
      const table = el('table', { class: 'keys' });
      block.rows.forEach(([keys, does], i) => { const row = el('tr'), a = el('td'), b = el('td'); row.dataset.b = at(i); a.append(inline(tg(keys))); b.append(inline(tg(does))); row.append(a, b); table.append(row); });
      return table;
    }
  }
}

function renderSection(section: Section, index: number, figures: { dispose(): void }[]): HTMLElement {
  const root = el('section', { class: 'guide-section', id: `guide-${section.id}` });
  root.append(el('h2', {}, el('span', { class: 'num', textContent: String(index + 1) }), tg(section.title)));
  section.blocks.forEach((block, b) => root.append(renderBlock(block, figures, item => blockPath(index, b, item))));
  return root;
}

/** A search result's text as nodes: the stretches the query matched are marked. */
function marked(pieces: Piece[]): (Node | string)[] {
  return pieces.map(piece => piece.mark ? el('mark', { textContent: piece.text }) : piece.text);
}

/** Open the guide, at `section` when given (and scroll there if it is already open). */
export async function openGuide(section?: string): Promise<void> {
  if (open) { if (section) open.scrollTo(section); return; }
  if (opening) return;
  opening = true;
  try { await loadWords(); } finally { opening = false; }
  if (open) { if (section) (open as { scrollTo(id: string): void }).scrollTo(section); return; }
  // The tour was asked for while the words were being fetched: it has the page, and the guide waits to be asked again.
  if (document.querySelector('dialog.tour')) return;
  const figures: { dispose(): void }[] = [];
  const dialog = el('dialog', { class: 'guide', ariaLabel: t('Guide') });
  const closeButton = el('button', { type: 'button', class: 'guide-x', tip: t('Close the guide (Esc)'), ariaLabel: t('Close the guide') });
  const tourButton = el('button', { type: 'button', class: 'guide-tour', textContent: t('Take the tour'), tip: t('A one-minute tour of the page: what the map shows and where everything is. The Guide goes deeper.'), onclick: () => { close(); takeTour(); } });
  const head = el('header', { class: 'guide-head' }, el('div', {}, el('h1', { textContent: t('Guide') }), el('span', { class: 'sub', textContent: (isCoarse() ? t('About {n} minutes to read. Pictures move: tap to look closer, pause or scrub them.', { n: readingMinutes() }) : t('About {n} minutes to read. Pictures move: hover, pause or scrub them.', { n: readingMinutes() })) })), tourButton, closeButton);
  const toc = el('nav', { class: 'guide-toc', ariaLabel: t('Contents') });
  const select = el('select', { class: 'guide-jump', ariaLabel: t('Jump to a section') });
  const scroller = el('div', { class: 'guide-scroll', tabIndex: -1 }), article = el('article', { class: 'guide-article' });
  const links = new Map<string, HTMLAnchorElement>();
  let group: HTMLOptGroupElement | null = null;
  SECTIONS.forEach((section, i) => {
    article.append(renderSection(section, i, figures));
    if (section.part) {
      toc.append(el('div', { class: 'guide-part', textContent: tg(section.part) }));
      group = el('optgroup', { label: tg(section.part) }); select.append(group);
    }
    const a = el('a', { href: `#guide/${section.id}`, class: 'guide-link' }, el('span', { class: 'num', textContent: String(i + 1) }), tg(section.title));
    a.addEventListener('click', event => { event.preventDefault(); scrollTo(section.id); });
    links.set(section.id, a); toc.append(a);
    (group ?? select).append(new Option(`${i + 1}. ${tg(section.title)}`, section.id));
  });
  article.append(el('footer', { class: 'guide-end' }, el('p', { textContent: isCoarse() ? t('That is the whole page. Everything else is a long press away: every button explains itself, and the ? beside a pane says what it is.') : t('That is the whole page. Everything else is a hover away: every button explains itself, and the ? beside a pane says what it is.') }),
    el('button', { type: 'button', textContent: t('Back to the top'), onclick: () => scroller.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }) })));
  scroller.append(article);

  // The search: a box over the contents list, whose place the answer takes while something is typed.
  const index = buildIndex(entriesOf(SECTIONS, tg));
  const query = el('input', { type: 'text', class: 'guide-q', placeholder: t('Search the guide'), ariaLabel: t('Search the guide'), autocomplete: 'off', spellcheck: false, enterKeyHint: 'search' });
  query.setAttribute('role', 'searchbox'); query.setAttribute('inputmode', 'search'); query.setAttribute('autocapitalize', 'off');
  const clearButton = el('button', { type: 'button', class: 'guide-q-x', hidden: true, tip: t('Clear the search'), ariaLabel: t('Clear the search'), onclick: () => { setQuery(''); query.focus(); } });
  const results = el('div', { class: 'guide-toc guide-results' });
  results.setAttribute('aria-live', 'polite');
  const side = el('div', { class: 'guide-side' }, el('div', { class: 'guide-search', role: 'search' }, query, clearButton), toc, results);
  dialog.append(head, el('div', { class: 'guide-body' }, side, scroller));
  document.body.append(dialog);
  select.onchange = () => scrollTo(select.value);
  head.append(select);

  function scrollTo(id: string): void {
    const target = article.querySelector<HTMLElement>(`#guide-${CSS.escape(id)}`); if (!target) return;
    scroller.scrollTo({ top: target.offsetTop - 8, behavior: reducedMotion() ? 'auto' : 'smooth' });
    highlight(id); history.replaceState(null, '', `#guide/${id}`);
  }
  let current = SECTIONS[0]!.id;
  function highlight(id: string): void { current = id; for (const [key, link] of links) link.classList.toggle('on', key === id); select.value = id; links.get(id)?.scrollIntoView({ block: 'nearest' }); }

  // The paragraph a result names comes to the top and is lit for a moment.
  let flashTimer = 0;
  function pick(found: Found): void {
    const id = SECTIONS[found.section]!.id;
    const target = found.path ? article.querySelector<HTMLElement>(`[data-b="${found.path}"]`) : null;
    if (!target) { scrollTo(id); } else {
      // Measured by where it is drawn, not by `offsetTop`: a key-table row's offset parent is its table, not the scroller.
      const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
      scroller.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? 'auto' : 'smooth' });
      article.querySelectorAll('.flash').forEach(node => node.classList.remove('flash'));
      void target.offsetWidth; target.classList.add('flash');
      clearTimeout(flashTimer); flashTimer = window.setTimeout(() => target.classList.remove('flash'), 2400);
      highlight(id); history.replaceState(null, '', `#guide/${id}`);
    }
    if (narrow()) { results.classList.add('away'); scroller.focus({ preventScroll: true }); } // the text is what the reader came for, and the keys scroll it
  }

  const lead = new Map<number, string>();
  for (const ix of index) if (!ix.entry.title && !lead.has(ix.entry.section)) lead.set(ix.entry.section, ix.entry.text);
  function showResults(): void {
    const text = query.value.trim(), active = canSearch(text);
    clearButton.hidden = query.value === '';
    side.toggleAttribute('data-searching', active);
    results.classList.remove('away'); results.replaceChildren();
    if (!active) { links.get(current)?.scrollIntoView({ block: 'nearest' }); return; } // a letter is not a question yet: the contents list is back, at the section being read
    const found = search(index, text);
    if (!found.length) { results.append(el('p', { class: 'guide-none', textContent: t('Nothing in the guide matches that.') })); return; }
    for (const f of found) {
      const title = tg(SECTIONS[f.section]!.title);
      const body = f.title ? snippet(lead.get(f.section) ?? '', []) : snippet(f.text, f.ranges);
      results.append(el('button', { type: 'button', class: 'guide-hit', onclick: () => pick(f) },
        el('span', { class: 'num', textContent: String(f.section + 1) }),
        el('span', { class: 'guide-hit-t' }, el('b', {}, ...(f.title ? marked(snippet(title, f.ranges, 200)) : [title])), el('span', { class: 'guide-hit-s' }, ...marked(body)))));
    }
  }
  function setQuery(text: string): void { query.value = text; showResults(); }
  query.addEventListener('input', showResults);
  query.addEventListener('focus', () => { if (canSearch(query.value)) results.classList.remove('away'); });
  // Enter and the arrows belong to an input method while it is composing (Japanese, Chinese, Korean); 229 is what Safari sends after it.
  const composing = (event: KeyboardEvent): boolean => event.isComposing || event.keyCode === 229;
  query.addEventListener('keydown', event => {
    if (composing(event)) return;
    if (event.key === 'Enter') { event.preventDefault(); results.querySelector<HTMLButtonElement>('.guide-hit')?.click(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector<HTMLButtonElement>('.guide-hit')?.focus(); }
  });
  results.addEventListener('keydown', event => {
    const hits = [...results.querySelectorAll<HTMLButtonElement>('.guide-hit')], at = hits.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); hits[Math.min(hits.length - 1, at + 1)]!.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (at === 0) query.focus(); else hits[at - 1]!.focus(); }
  });
  // A slash goes to the box, as on most pages with one (not while typing in a field or choosing in the picker).
  dialog.addEventListener('keydown', event => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
    event.preventDefault(); query.focus(); query.select();
  });

  // The section at the top of the text is the one the index marks.
  const spy = (): void => {
    const edge = scroller.scrollTop + 40; let current = SECTIONS[0]!.id;
    for (const section of SECTIONS) { const node = article.querySelector<HTMLElement>(`#guide-${CSS.escape(section.id)}`); if (node && node.offsetTop <= edge) current = section.id; }
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1]!.id;
    highlight(current);
  };
  scroller.addEventListener('scroll', () => requestAnimationFrame(spy), { passive: true });

  // Movable by its title bar like the panels (not by the close button or the section picker in it), and kept inside the page when that changes size.
  const drag = makeDraggable(dialog, { grabs: target => target.closest('.guide-head') !== null && !target.closest('button, select, a'), enabled: () => !compactBar(), size: () => ({ width: dialog.offsetWidth, need: dialog.offsetHeight }) });
  const keepInside = (): void => drag.clamp();
  window.addEventListener('resize', keepInside);

  const close = (): void => {
    if (!open) return; open = null;
    window.removeEventListener('resize', keepInside);
    clearTimeout(flashTimer);
    for (const figure of figures) figure.dispose();
    dialog.close(); dialog.remove();
    if (/^#guide/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  };
  closeButton.onclick = close;
  // Esc first puts away what was typed in the search box, and closes the guide only when there is nothing there to put away.
  // A browser lets a page refuse Esc only after a key or pointer event not already used up: where it will not be refused (text put in by dictation, a second Esc),
  // the dialog is closing whatever is said here, so the guide closes with it (`close` below is idempotent) and can be opened again.
  dialog.addEventListener('cancel', event => { if (query.value !== '' && event.cancelable) { event.preventDefault(); setQuery(''); query.focus(); return; } event.preventDefault(); close(); });
  dialog.addEventListener('close', close);
  dialog.addEventListener('pointerdown', event => { if (event.target === dialog) close(); }); // a click on the dimmed margin
  dialog.showModal();
  open = { dialog, scrollTo, close };
  highlight(SECTIONS[0]!.id);
  const wanted = section && SECTIONS.some(s => s.id === section) ? section : null;
  if (wanted) requestAnimationFrame(() => scrollTo(wanted)); else history.replaceState(null, '', '#guide');
}

/** Open the guide when the address asks for it (`#guide` or `#guide/<section>`). */
export function openFromAddress(): boolean {
  const match = /^#guide(?:\/([a-z-]+))?$/.exec(location.hash); if (!match) return false;
  void openGuide(match[1]); return true;
}
