/**
 * A small page for tests of page elements (the Plus pop-up, the key form): elements with attributes, classes, children, events, focus, a
 * form's submit, and selectors by tag, class, id and [attribute="value"]. Only what those modules use; `install()` puts `document` and
 * `window` in place and gives back the function that takes them away.
 */
type Listener = (event: FakeEvent) => void;

export class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  target: FakeElement | null = null;
  constructor(readonly type: string, readonly init: { bubbles?: boolean; key?: string; shiftKey?: boolean } = {}) {}
  get key(): string { return this.init.key ?? ''; }
  get shiftKey(): boolean { return this.init.shiftKey ?? false; }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
}

class ClassList {
  constructor(private el: FakeElement) {}
  #set(): Set<string> { return new Set(this.el.className.split(/\s+/).filter(Boolean)); }
  add(...names: string[]): void { const s = this.#set(); for (const n of names) s.add(n); this.el.className = [...s].join(' '); }
  remove(...names: string[]): void { const s = this.#set(); for (const n of names) s.delete(n); this.el.className = [...s].join(' '); }
  contains(name: string): boolean { return this.#set().has(name); }
  toggle(name: string, on?: boolean): boolean { const want = on ?? !this.contains(name); if (want) this.add(name); else this.remove(name); return want; }
}

let page: FakePage | null = null;

export class FakeElement {
  children: (FakeElement | FakeText)[] = [];
  parent: FakeElement | null = null;
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = '';
  hidden = false;
  disabled = false;
  readOnly = false;
  value = '';
  type = '';
  id = '';
  tabIndex = 0;
  selectionStart = 0;
  selectionEnd = 0;
  #listeners = new Map<string, Set<Listener>>();
  readonly classList = new ClassList(this);
  onclick: ((event: FakeEvent) => void) | null = null;
  onsubmit: ((event: FakeEvent) => void) | null = null;
  constructor(readonly tagName: string) {}
  get nodeType(): number { return 1; }
  get textContent(): string { return this.children.map(c => c.textContent).join(''); }
  set textContent(text: string) { this.children = []; if (text) this.children.push(new FakeText(text, this)); }
  get innerText(): string { return this.textContent; }
  get isConnected(): boolean { let n: FakeElement | null = this; while (n) { if (n === page?.body) return true; n = n.parent; } return false; }
  get form(): FakeElement | null { let n = this.parent; while (n && n.tagName !== 'FORM') n = n.parent; return n; }
  get childElementCount(): number { return this.children.filter(c => c instanceof FakeElement).length; }
  get parentElement(): FakeElement | null { return this.parent; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, String(value)); if (name === 'class') this.className = String(value); if (name === 'id') this.id = String(value); }
  getAttribute(name: string): string | null { if (name === 'class') return this.className || null; if (name === 'id') return this.id || null; return this.attrs.get(name) ?? null; }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  set ariaLabel(v: string) { this.attrs.set('aria-label', v); }
  get ariaLabel(): string { return this.attrs.get('aria-label') ?? ''; }
  set ariaHidden(v: string) { this.attrs.set('aria-hidden', v); }
  set role(v: string) { this.attrs.set('role', v); }
  get role(): string { return this.attrs.get('role') ?? ''; }
  set htmlFor(v: string) { this.attrs.set('for', v); }
  set placeholder(v: string) { this.attrs.set('placeholder', v); }
  set autocomplete(v: string) { this.attrs.set('autocomplete', v); }
  set spellcheck(v: boolean) { this.attrs.set('spellcheck', String(v)); }
  set noValidate(v: boolean) { this.attrs.set('novalidate', String(v)); }
  set href(v: string) { this.attrs.set('href', v); }
  set target(v: string) { this.attrs.set('target', v); }
  set rel(v: string) { this.attrs.set('rel', v); }
  #adopt(child: FakeElement | FakeText | string): FakeElement | FakeText {
    const node = typeof child === 'string' ? new FakeText(child, this) : child;
    if (node instanceof FakeElement) { node.parent?.removeChild(node); node.parent = this; } else node.parent = this;
    return node;
  }
  append(...nodes: (FakeElement | FakeText | string)[]): void { for (const n of nodes) this.children.push(this.#adopt(n)); }
  prepend(...nodes: (FakeElement | FakeText | string)[]): void { this.children.unshift(...nodes.map(n => this.#adopt(n))); }
  replaceChildren(...nodes: (FakeElement | FakeText | string)[]): void { for (const c of this.children) this.#forget(c); this.children = []; this.append(...nodes); }
  removeChild(child: FakeElement | FakeText): void { const i = this.children.indexOf(child); if (i >= 0) { this.children.splice(i, 1); this.#forget(child); } }
  #forget(child: FakeElement | FakeText): void {
    child.parent = null;
    // A focused element taken out of the page loses the focus (to the body), as a browser's does.
    if (child instanceof FakeElement && page && page.activeElement && (page.activeElement === child || child.contains(page.activeElement))) page.activeElement = page.body;
  }
  remove(): void { this.parent?.removeChild(this); }
  contains(other: unknown): boolean { let n = other instanceof FakeElement || other instanceof FakeText ? other : null; while (n) { if (n === this) return true; n = n.parent; } return false; }
  addEventListener(type: string, fn: Listener): void { let s = this.#listeners.get(type); if (!s) this.#listeners.set(type, s = new Set()); s.add(fn); }
  removeEventListener(type: string, fn: Listener): void { this.#listeners.get(type)?.delete(fn); }
  dispatchEvent(event: FakeEvent): boolean {
    event.target ??= this;
    for (let n: FakeElement | null = this; n; n = event.init.bubbles ? n.parent : null) {
      for (const fn of [...(n.#listeners.get(event.type) ?? [])]) fn(event);
      const own = event.type === 'click' ? n.onclick : event.type === 'submit' ? n.onsubmit : null;
      if (own) own(event);
      if (event.propagationStopped) break;
    }
    return !event.defaultPrevented;
  }
  click(): void { if (this.disabled) return; this.dispatchEvent(new FakeEvent('click', { bubbles: true })); }
  focus(): void { if (page && this.isConnected) page.activeElement = this; }
  blur(): void { if (page && page.activeElement === this) page.activeElement = page.body; }
  select(): void { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  requestSubmit(): void { this.dispatchEvent(new FakeEvent('submit', { bubbles: true })); }
  /** A dialog shown (`open`) or closed. */
  show(): void { this.attrs.set('open', ''); }
  close(): void { this.attrs.delete('open'); }
  getClientRects(): { length: number } { return { length: this.isConnected && !this.hidden ? 1 : 0 }; }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  scrollIntoView(): void { /* nothing to scroll */ }
  /** Every element under this one, in document order. */
  all(): FakeElement[] { const out: FakeElement[] = []; const walk = (e: FakeElement): void => { for (const c of e.children) if (c instanceof FakeElement) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(selector: string): FakeElement[] { const parts = selector.split(',').map(s => s.trim()); return this.all().filter(e => parts.some(p => matches(e, p))); }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): FakeElement | null { let n: FakeElement | null = this; while (n) { if (matches(n, selector)) return n; n = n.parent; } return null; }
}

export class FakeText {
  constructor(public textContent: string, public parent: FakeElement | null) {}
  get nodeType(): number { return 3; }
}

/** One simple selector, or a descendant chain of them ("a .b"): tag, .class, #id, [attr] / [attr="value"], joined without spaces. */
function matches(el: FakeElement, selector: string): boolean {
  const chain = selector.trim().split(/\s+/);
  if (!one(el, chain[chain.length - 1]!)) return false;
  let n = el.parent;
  for (let i = chain.length - 2; i >= 0; i--) { while (n && !one(n, chain[i]!)) n = n.parent; if (!n) return false; n = n.parent; }
  return true;
}
function one(el: FakeElement, simple: string): boolean {
  const re = /([.#]?[\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|(:not\(\[([\w-]+)(?:="([^"]*)")?\]\))/g;
  let m: RegExpExecArray | null, ok = true;
  while ((m = re.exec(simple))) {
    if (m[1]) {
      const s = m[1];
      if (s.startsWith('.')) ok &&= el.classList.contains(s.slice(1));
      else if (s.startsWith('#')) ok &&= el.id === s.slice(1);
      else ok &&= el.tagName === s.toUpperCase();
    } else if (m[2]) ok &&= attr(el, m[2]) !== null && (m[3] === undefined || attr(el, m[2]) === m[3]);
    else if (m[4]) ok &&= !(attr(el, m[5]!) !== null && (m[6] === undefined || attr(el, m[5]!) === m[6]));
  }
  return ok;
}
function attr(el: FakeElement, name: string): string | null {
  if (name.startsWith('data-')) { const key = name.slice(5).replace(/-(\w)/g, (_m, c: string) => c.toUpperCase()); return Object.hasOwn(el.dataset, key) ? el.dataset[key]! : null; }
  if (name === 'type') return el.type || null;
  if (name === 'tabindex') return String(el.tabIndex);
  return el.getAttribute(name);
}

export class FakePage {
  readonly body = new FakeElement('BODY');
  readonly html = new FakeElement('HTML');
  activeElement: FakeElement | null = this.body;
  readonly listeners = new Map<string, Set<Listener>>();
  constructor() { this.html.append(this.body); }
  /** Put `document` and `window` in place for the code under test; returns the function that takes them away again. */
  install(): () => void {
    page = this;
    const self = this;
    const document = {
      body: this.body, documentElement: this.html,
      get activeElement() { return self.activeElement; },
      createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
      createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
      createTextNode: (text: string) => new FakeText(text, null),
      querySelector: (s: string) => this.html.querySelector(s),
      querySelectorAll: (s: string) => this.html.querySelectorAll(s),
      addEventListener: (type: string, fn: Listener) => { let s = this.listeners.get(type); if (!s) this.listeners.set(type, s = new Set()); s.add(fn); },
      removeEventListener: (type: string, fn: Listener) => { this.listeners.get(type)?.delete(fn); },
      dispatchEvent: () => true,
    };
    const window = { setTimeout, clearTimeout, setInterval, clearInterval, innerWidth: 1280, innerHeight: 800, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), location: { href: 'http://localhost/', search: '' } };
    const saved = new Map<string, PropertyDescriptor | undefined>();
    const put = (name: string, value: unknown): void => { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
    put('document', document); put('window', window);
    put('HTMLElement', FakeElement); put('HTMLInputElement', FakeElement); put('Node', FakeElement);
    put('requestAnimationFrame', (run: (t: number) => void) => setTimeout(() => run(0), 0)); put('matchMedia', window.matchMedia);
    return () => { for (const [name, d] of saved) { if (d) Object.defineProperty(globalThis, name, d); else delete (globalThis as Record<string, unknown>)[name]; } page = null; };
  }
  /** A key pressed on the document (its listeners only: the capture listeners the code under test adds there). */
  key(key: string, shiftKey = false): FakeEvent { const e = new FakeEvent('keydown', { key, shiftKey }); for (const fn of [...(this.listeners.get('keydown') ?? [])]) fn(e); return e; }
}
