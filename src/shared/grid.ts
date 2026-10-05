/** Pick a 1-2-5 price-grid step of roughly 0.02% of price. Shared by the recorder and the browser. */
export function gridStepFor(price: number): number {
  const raw = Math.max(price * 0.0002, 1e-9);
  const exp = Math.floor(Math.log10(raw));
  const unit = raw / 10 ** exp;
  const nice = unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10;
  return Number((nice * 10 ** exp).toPrecision(12));
}
