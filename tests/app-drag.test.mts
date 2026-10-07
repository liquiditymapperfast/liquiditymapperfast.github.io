import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDraggable } from '../src/app/drag.ts';

// The pointer handling of a window dragged by its title bar, against a stand-in for the page: just enough of the DOM to press, move and drop.

class FakeElement extends EventTarget {
  style: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly classList = { add: (name: string) => { this.classes.add(name); }, remove: (name: string) => { this.classes.delete(name); } };
  failCapture = false;
  constructor(readonly role: string, private box = { left: 100, top: 50, width: 300, height: 200 }) { super(); }
  getBoundingClientRect() {
    const left = this.style.left ? parseFloat(this.style.left) : this.box.left, top = this.style.top ? parseFloat(this.style.top) : this.box.top;
    return { left, top, right: left + this.box.width, bottom: top + this.box.height, width: this.box.width, height: this.box.height };
  }
  setPointerCapture(): void { if (this.failCapture) throw new Error('InvalidStateError'); }
  releasePointerCapture(): void { /* nothing is held */ }
  closest(selector: string): FakeElement | null { return selector.split(',').map(s => s.trim()).includes(this.role) ? this : null; }
}

const page = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 });
const frames: (() => void)[] = [];
(globalThis as Record<string, unknown>).window = page;
(globalThis as Record<string, unknown>).Element = FakeElement;
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => frames.push(callback);
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => { frames[id - 1] = () => {}; };
const nextFrame = (): void => { const run = frames.splice(0); for (const callback of run) callback(); };

function pointer(target: EventTarget, type: string, x: number, y: number, over: FakeElement = target as FakeElement, button = 0): void {
  const event = Object.assign(new Event(type, { cancelable: true }), { button, clientX: x, clientY: y, pointerId: 1 });
  Object.defineProperty(event, 'target', { value: over });
  target.dispatchEvent(event);
}
const press = (root: FakeElement, over: FakeElement, x: number, y: number, button = 0): void => pointer(root, 'pointerdown', x, y, over, button);
const move = (x: number, y: number): void => pointer(page, 'pointermove', x, y, new FakeElement('canvas'));
const release = (x: number, y: number): void => pointer(page, 'pointerup', x, y, new FakeElement('canvas'));

function rig(over: { enabled?: boolean } = {}) {
  const root = new FakeElement('panel'), title = new FakeElement('h3'), close = new FakeElement('button');
  const writes: string[] = [];
  const watched = new Proxy(root.style, { set(style, key, value) { writes.push(`${String(key)}=${value}`); style[key as string] = value; return true; } });
  root.style = watched;
  const options = { enabled: true, ...over };
  const drag = makeDraggable(root as unknown as HTMLElement, {
    grabs: target => (target as unknown as FakeElement).role === 'h3',
    enabled: () => options.enabled,
    size: () => ({ width: 300, need: 600 }),
  });
  return { root, title, close, drag, writes, options };
}

test('a press on the title that moves only a few pixels is a click; further than that the window follows the pointer, written once a frame', () => {
  const { root, title, drag, writes } = rig();
  press(root, title, 150, 60);
  move(152, 61); release(152, 61); nextFrame();
  assert.equal(drag.moved(), false, 'two pixels is still a click');
  assert.deepEqual(writes, [], 'and nothing on the page was touched');
  press(root, title, 150, 60);                                            // the grip is 50 px right of the left edge and 10 below the top
  move(200, 90); move(300, 160); move(400, 260);                          // three moves inside one frame
  assert.equal(drag.moved(), true);
  assert.ok(root.classes.has('being-moved'), 'marked while it is held');
  assert.equal(root.style.margin, '0'); assert.equal(root.style.inset, 'auto');
  const before = writes.length; nextFrame();
  assert.equal(root.style.left, '350px', 'the left edge is where the pointer is, less the 50 px it was held by');
  assert.equal(root.style.top, '250px');
  assert.equal(root.style.maxHeight, `${800 - 250 - 8}px`, 'it may be as tall as the room from its top to the bottom of the window');
  assert.equal(writes.length - before, 3, 'left, top and maximum height: three writes for three moves');
  move(400, 260); nextFrame();
  assert.equal(writes.length - before, 3, 'a move that changes nothing writes nothing');
  release(400, 260);
  assert.ok(!root.classes.has('being-moved'), 'let go');
  move(500, 400); nextFrame();
  assert.equal(root.style.left, '350px', 'and it no longer follows');
});

test('the window is held inside the page, with the floor of it showing, wherever the pointer goes', () => {
  const { root, title } = rig();
  press(root, title, 150, 60);
  move(5_000, 5_000); release(5_000, 5_000);
  assert.equal(root.style.left, `${1000 - 300 - 8}px`);
  assert.equal(root.style.top, `${800 - 8 - 180}px`);
  assert.equal(root.style.maxHeight, '180px');
  press(root, title, 800, 620);
  move(-5_000, -5_000); release(-5_000, -5_000);
  assert.equal(root.style.left, '8px'); assert.equal(root.style.top, '8px');
  assert.equal(root.style.maxHeight, `${800 - 16}px`, 'at the top it may use the whole height');
});

test('only a left press on the title, while dragging is on, takes hold; a button in the bar, another button and a disabled window do not', () => {
  const a = rig();
  press(a.root, a.close, 150, 60); move(300, 300); release(300, 300);
  assert.equal(a.drag.moved(), false, 'the close button is not a handle');
  press(a.root, a.title, 150, 60, 2); move(300, 300); release(300, 300);
  assert.equal(a.drag.moved(), false, 'neither is the right button');
  const b = rig({ enabled: false });
  press(b.root, b.title, 150, 60); move(300, 300); release(300, 300);
  assert.equal(b.drag.moved(), false, 'a phone shows sheets: nothing moves there');
  const c = rig();
  press(c.root, c.title, 150, 60); move(300, 300);
  assert.equal(c.drag.moved(), true);
  release(300, 300);
});

test('a drag goes on when the browser refuses the pointer capture or takes it back (it did, driven over the debugging protocol, and the drag ended on its first move)', () => {
  const { root, title, drag } = rig();
  root.failCapture = true;                                                 // the capture is refused
  press(root, title, 150, 60); move(250, 160); nextFrame();
  assert.equal(root.style.left, '200px'); assert.equal(root.style.top, '150px');
  root.dispatchEvent(new Event('lostpointercapture'));                      // and one that is taken back mid-drag
  move(350, 260); nextFrame();
  assert.equal(root.style.left, '300px', 'it still follows');
  release(350, 260);
  assert.equal(drag.moved(), true);
});

test('reset forgets the move and what it wrote; clamp brings a moved window back inside a page that shrank', () => {
  const { root, title, drag } = rig();
  press(root, title, 150, 60); move(850, 600); release(850, 600);
  assert.equal(root.style.left, `${1000 - 300 - 8}px`, 'held inside the page it was dropped in');
  page.innerWidth = 600; page.innerHeight = 500;
  drag.clamp();
  assert.equal(root.style.left, `${600 - 300 - 8}px`, 'inside the narrower page');
  assert.equal(root.style.top, `${500 - 8 - 180}px`);
  assert.equal(root.style.maxHeight, '180px');
  page.innerWidth = 1000; page.innerHeight = 800;
  press(root, title, 150, 60); move(300, 300);
  drag.reset();
  assert.equal(drag.moved(), false);
  for (const property of ['margin', 'inset', 'left', 'top', 'maxHeight']) assert.equal(root.style[property], '', property);
  assert.ok(!root.classes.has('being-moved'));
  move(600, 600); nextFrame();
  assert.equal(root.style.left, '', 'a drag that was under way when it was reset does not go on');
});
