import { el } from './dom.ts';

/**
 * Put `text` on the clipboard: the browser's clipboard, else a selected text box copied the older way, the keyboard given back to where it
 * was. Whether it worked. (The Scripts panel's and the frame-rate panel's Copy for AI.)
 */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* the older way below */ }
  const was = document.activeElement, box = el('textarea', { value: text });
  box.readOnly = true; box.style.position = 'fixed'; box.style.left = '-10000px'; box.style.top = '0'; box.style.opacity = '0';
  document.body.append(box); box.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { box.remove(); if (was instanceof HTMLElement && was.isConnected) was.focus({ preventScroll: true }); }
}
