/** Create an element with properties and children. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string; /** Tooltip text (shown by `tip.ts`; never the native `title`). */ tip?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, tip, ...rest } = props;
  if (cls) node.className = cls;
  if (tip) node.dataset.tip = tip;
  Object.assign(node, rest);
  node.append(...children);
  return node;
}
