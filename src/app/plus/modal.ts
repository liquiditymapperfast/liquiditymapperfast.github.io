/**
 * The keys of the presentation sheet (sheet.ts), apart from it so they can be tested without its styles: Escape closes it, Tab keeps the focus
 * inside it (`trapStep`, the levels sheet's rule).
 */
import { trapStep } from '../levels-control.ts';

/** What Tab and Escape do in the sheet: close it, keep the focus inside it, or let the browser move it (`trapStep`). */
export function sheetKey(key: string, shift: boolean, index: number, count: number): 'close' | { focus: number } | null {
  if (key === 'Escape') return 'close';
  if (key !== 'Tab') return null;
  const to = trapStep(count, index, shift);
  return to === null ? null : { focus: to };
}

