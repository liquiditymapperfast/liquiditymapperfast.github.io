import { el } from './dom.ts';

/**
 * A short message at the foot of the page that goes by itself, with, where there is one, a way back (Undo). One at a time: a newer one
 * replaces it. It does not take the keyboard and is spoken to a screen reader as a status.
 */
export interface ToastOptions { action?: { label: string; run: () => void }; actions?: readonly { label: string; run: () => void }[]; ms?: number }

let current: { root: HTMLElement; timer: number } | null = null;

export function dismissToast(): void {
  if (!current) return;
  window.clearTimeout(current.timer); current.root.remove(); current = null;
}

export function toast(text: string, options: ToastOptions = {}): void {
  dismissToast();
  // Two choices or more: the words on a line of their own over them, or a phone squeezes them a word a line.
  const many = (options.actions?.length ?? 0) > 1;
  const root = el('div', { class: `toast${many ? ' toast-many' : ''}`, role: 'status' }, el('span', { class: 'toast-text', textContent: text }));
  // One way back (Undo), or a few choices (an anchor placed on a touch screen: Place here, Cancel).
  for (const { label, run } of options.actions ?? (options.action ? [options.action] : [])) {
    root.append(el('button', { type: 'button', class: 'toast-action', textContent: label, onclick: () => { dismissToast(); run(); } }));
  }
  document.body.append(root);
  current = { root, timer: window.setTimeout(dismissToast, options.ms ?? 9_000) };
}
