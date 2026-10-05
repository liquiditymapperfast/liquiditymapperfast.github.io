import { el } from './dom.ts';
import { togglePanel, type Panel } from './ui.ts';

/** Where the author and the code can be found. The GitHub address names the account until the repository has its own page. */
export const AUTHOR = Object.freeze({
  name: 'Karl',
  line: 'I love building things.',
  x: 'https://x.com/karlbooklover',
  xHandle: '@karlbooklover',
  github: 'https://github.com/liquiditymapperfast',
});

function link(href: string, label: string, detail: string): HTMLAnchorElement {
  return el('a', { class: 'author-link', href, target: '_blank', rel: 'noopener noreferrer' }, el('b', { textContent: label }), el('span', { textContent: detail }));
}

/** The author box: what this project is, who made it, and where to find them. Opens under `anchor`. */
export function toggleAuthor(anchor: HTMLElement): Panel | null {
  return togglePanel(anchor, { title: 'About', width: 340, align: 'right' }, (_tools, body) => {
    body.classList.add('author-body');
    body.append(
      el('div', { class: 'author-card' },
        el('div', { class: 'avatar', textContent: AUTHOR.name[0] ?? 'K', ariaHidden: 'true' }),
        el('div', {}, el('strong', { textContent: AUTHOR.name }), el('p', { textContent: AUTHOR.line }))),
      el('p', { class: 'lead', textContent: 'LiquidityMapperFast is a free project. There is nothing to sign up for, no account, no strings attached, and the code is open source.' }),
      el('p', { class: 'fine', textContent: 'It reads public exchange data straight from your browser and sends nothing to anyone. It is built in free time, so things can occasionally break; tell me when they do.' }),
      el('div', { class: 'author-links' }, link(AUTHOR.x, 'X', AUTHOR.xHandle), link(AUTHOR.github, 'GitHub', 'source code and issues')),
    );
  });
}
