import { el } from './dom.ts';

/**
 * A short message at the foot of the page that goes by itself, with, where there is one, a way back (Undo). One at a time: a newer one
 * replaces it. It does not take the keyboard and is spoken to a screen reader as a status.
 */
export interface ToastOptions { action?: { label: string; run: () => void }; ms?: number }

let current: { root: HTMLElement; timer: number } | null = null;

export function dismissToast(): void {
  if (!current) return;
  window.clearTimeout(current.timer); current.root.remove(); current = null;
}

export function toast(text: string, options: ToastOptions = {}): void {
  dismissToast();
  const root = el('div', { class: 'toast', role: 'status' }, el('span', { class: 'toast-text', textContent: text }));
  if (options.action) {
    const { label, run } = options.action;
    root.append(el('button', { type: 'button', class: 'toast-action', textContent: label, onclick: () => { dismissToast(); run(); } }));
  }
  document.body.append(root);
  current = { root, timer: window.setTimeout(dismissToast, options.ms ?? 9_000) };
}
