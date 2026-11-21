/**
 * The demo's own levels control, used until the app's control is passed to `mountDemo` (`control`): a switch for each kind and the Traders
 * choice, reading and writing the demo's store and nothing else. It has the same shape as that one, `(host, store) => { destroy }`.
 */
import { t } from '../../i18n.ts';
import { DEMO_KINDS, lastOn, type DemoKind, type DemoStore, type DemoTraders } from './store.ts';
import { sample } from './svg.ts';

/** How long the note under the switches stays after a press on the last kind that is on. */
const NOTE_MS = 3200;

const kindName = (kind: DemoKind): string => kind === 'liq' ? t('Liquidations') : kind === 'stops' ? t('Stops') : t('Take profits');
const tradersName = (v: DemoTraders): string => v === 'everyone' ? t('Everyone') : t('+PnL only');

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  el.append(...children);
  return el;
}

let uid = 0;

export function builtInControl(host: HTMLElement, store: DemoStore): { destroy(): void } {
  const id = `pd-lv${++uid}`;
  const head = node('h3', 'pd-lv-head', t('Levels'));
  head.id = `${id}h`;
  const rows = node('div', 'pd-lv-rows');
  rows.setAttribute('role', 'group'); rows.setAttribute('aria-labelledby', head.id);
  const note = node('p', 'pd-lv-note');
  note.setAttribute('aria-live', 'polite');
  let noteTimer = 0;
  const say = (words: string): void => {
    note.textContent = words;
    window.clearTimeout(noteTimer);
    noteTimer = words ? window.setTimeout(() => { noteTimer = 0; note.textContent = ''; }, NOTE_MS) : 0;
  };
  const switches = new Map<DemoKind, HTMLButtonElement>();
  for (const kind of DEMO_KINDS) {
    const b = node('button', 'pd-lv-row', sample(kind), node('span', 'pd-lv-label', kindName(kind)), node('span', 'pd-sw'));
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.addEventListener('click', () => {
      const s = store.get();
      if (lastOn(s, kind)) { say(t('One kind stays on.')); return; }
      store.set({ [kind]: !s[kind] });
    });
    rows.append(b);
    switches.set(kind, b);
  }
  const subId = `${id}t`;
  const sub = node('p', 'pd-lv-sub', t('Traders'));
  sub.id = subId;
  const seg = node('div', 'pd-seg');
  seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-labelledby', subId);
  const radios = new Map<DemoTraders, HTMLButtonElement>();
  for (const v of ['everyone', 'profitable'] as const) {
    const r = node('button', 'pd-seg-b', node('span', '', tradersName(v)));
    r.type = 'button';
    r.setAttribute('role', 'radio');
    r.addEventListener('click', () => { store.set({ traders: v }); });
    r.addEventListener('keydown', e => {
      // A radio group's keys: an arrow goes to the other choice, Home to the first, End to the last (and each is chosen as it is reached).
      const k = e.key, other: DemoTraders = v === 'everyone' ? 'profitable' : 'everyone';
      const next: DemoTraders | null = k === 'Home' ? 'everyone' : k === 'End' ? 'profitable' : k.startsWith('Arrow') ? other : null;
      if (!next) return;
      e.preventDefault();
      store.set({ traders: next });
      radios.get(next)!.focus();
    });
    seg.append(r);
    radios.set(v, r);
  }
  const root = node('div', 'pd-lv', head, rows, node('div', 'pd-lv-sec', sub, seg), note);
  host.append(root);

  const sync = (): void => {
    const s = store.get();
    for (const [kind, b] of switches) {
      b.setAttribute('aria-checked', String(s[kind]));
      if (lastOn(s, kind)) { b.setAttribute('aria-disabled', 'true'); b.dataset.tip = t('One kind stays on.'); }
      else { b.removeAttribute('aria-disabled'); delete b.dataset.tip; }
    }
    for (const [v, r] of radios) {
      const on = s.traders === v;
      r.setAttribute('aria-checked', String(on));
      r.classList.toggle('on', on);
      r.tabIndex = on ? 0 : -1;
    }
  };
  const stop = store.subscribe(sync);
  sync();
  return {
    destroy() { stop(); window.clearTimeout(noteTimer); noteTimer = 0; root.remove(); },
  };
}
