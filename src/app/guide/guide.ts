import { el } from '../dom.ts';
import { isCoarse } from '../device.ts';
import { SECTIONS, readingMinutes, type Block, type Section } from './content.ts';
import { createFigure } from './figures.ts';
import { parseInline } from './markup.ts';
import { language, t } from '../i18n.ts';

/**
 * The guide: a modal with the table of contents on the left and the text on the right, opened by the Guide button, by a "?" panel's link
 * (`#guide/<section>`), or by that address. It is loaded on demand. Figures animate only while they are on screen and stop with the guide.
 */
let open: { dialog: HTMLDialogElement; scrollTo(id: string): void; close(): void } | null = null;
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function inline(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const part of parseInline(source)) {
    if (part.kind === 'text') fragment.append(part.text);
    else fragment.append(el(part.kind === 'b' ? 'strong' : part.kind === 'i' ? 'em' : part.kind === 'code' ? 'code' : 'kbd', { textContent: part.text }));
  }
  return fragment;
}

function renderBlock(block: Block, figures: { dispose(): void }[]): HTMLElement {
  switch (block.t) {
    case 'p': { const p = el('p'); p.append(inline(block.text)); return p; }
    case 'list': { const ul = el('ul'); for (const item of block.items) { const li = el('li'); li.append(inline(item)); ul.append(li); } return ul; }
    case 'note': { const n = el('aside', { class: `note ${block.kind ?? 'tip'}` }); n.append(el('b', { textContent: block.kind === 'warn' ? 'Keep in mind' : 'Tip' }), inline(block.text)); return n; }
    case 'fig': { const f = createFigure(block.id, block.caption); figures.push(f); return f.root; }
    case 'keys': {
      const table = el('table', { class: 'keys' });
      for (const [keys, does] of block.rows) { const row = el('tr'), a = el('td'), b = el('td'); a.append(inline(keys)); b.append(inline(does)); row.append(a, b); table.append(row); }
      return table;
    }
  }
}

function renderSection(section: Section, index: number, figures: { dispose(): void }[]): HTMLElement {
  const root = el('section', { class: 'guide-section', id: `guide-${section.id}` });
  root.append(el('h2', {}, el('span', { class: 'num', textContent: String(index + 1) }), section.title));
  for (const block of section.blocks) root.append(renderBlock(block, figures));
  return root;
}

/** Open the guide, at `section` when given (and scroll there if it is already open). */
export function openGuide(section?: string): void {
  if (open) { if (section) open.scrollTo(section); return; }
  const figures: { dispose(): void }[] = [];
  const dialog = el('dialog', { class: 'guide', ariaLabel: t('Guide') });
  const closeButton = el('button', { type: 'button', class: 'guide-x', tip: t('Close the guide (Esc)'), ariaLabel: t('Close the guide') });
  const head = el('header', { class: 'guide-head' }, el('div', {}, el('h1', { textContent: t('Guide') }), el('span', { class: 'sub', textContent: (isCoarse() ? t('About {n} minutes to read. Pictures move: tap to look closer, pause or scrub them.', { n: readingMinutes() }) : t('About {n} minutes to read. Pictures move: hover, pause or scrub them.', { n: readingMinutes() })) + (language() === 'en' ? '' : ' ' + t('The text of the guide is in English for now.')) })), closeButton);
  const toc = el('nav', { class: 'guide-toc', ariaLabel: t('Contents') });
  const select = el('select', { class: 'guide-jump', ariaLabel: t('Jump to a section') });
  const scroller = el('div', { class: 'guide-scroll' }), article = el('article', { class: 'guide-article' });
  const links = new Map<string, HTMLAnchorElement>();
  SECTIONS.forEach((section, i) => {
    article.append(renderSection(section, i, figures));
    const a = el('a', { href: `#guide/${section.id}`, class: 'guide-link' }, el('span', { class: 'num', textContent: String(i + 1) }), section.title);
    a.addEventListener('click', event => { event.preventDefault(); scrollTo(section.id); });
    links.set(section.id, a); toc.append(a);
    select.append(new Option(`${i + 1}. ${section.title}`, section.id));
  });
  article.append(el('footer', { class: 'guide-end' }, el('p', { textContent: isCoarse() ? t('That is the whole page. Everything else is a long press away: every button explains itself, and the ? beside a pane says what it is.') : t('That is the whole page. Everything else is a hover away: every button explains itself, and the ? beside a pane says what it is.') }),
    el('button', { type: 'button', textContent: t('Back to the top'), onclick: () => scroller.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }) })));
  scroller.append(article);
  dialog.append(head, el('div', { class: 'guide-body' }, toc, scroller));
  document.body.append(dialog);
  select.onchange = () => scrollTo(select.value);
  head.append(select);

  function scrollTo(id: string): void {
    const target = article.querySelector<HTMLElement>(`#guide-${CSS.escape(id)}`); if (!target) return;
    scroller.scrollTo({ top: target.offsetTop - 8, behavior: reducedMotion() ? 'auto' : 'smooth' });
    highlight(id); history.replaceState(null, '', `#guide/${id}`);
  }
  function highlight(id: string): void { for (const [key, link] of links) link.classList.toggle('on', key === id); select.value = id; links.get(id)?.scrollIntoView({ block: 'nearest' }); }

  // The section at the top of the text is the one the index marks.
  const spy = (): void => {
    const edge = scroller.scrollTop + 40; let current = SECTIONS[0]!.id;
    for (const section of SECTIONS) { const node = article.querySelector<HTMLElement>(`#guide-${CSS.escape(section.id)}`); if (node && node.offsetTop <= edge) current = section.id; }
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1]!.id;
    highlight(current);
  };
  scroller.addEventListener('scroll', () => requestAnimationFrame(spy), { passive: true });

  const close = (): void => {
    if (!open) return; open = null;
    for (const figure of figures) figure.dispose();
    dialog.close(); dialog.remove();
    if (/^#guide/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  };
  closeButton.onclick = close;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
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
  openGuide(match[1]); return true;
}
