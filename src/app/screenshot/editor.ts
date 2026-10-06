import { el } from '../dom.ts';
import { isCoarse } from '../device.ts';
import { AUTHOR } from '../author.ts';
import { setTip } from '../tip.ts';
import { capturePage, type Snapshot } from './capture.ts';
import {
  COLORS, CURSORS, WIDTHS, clampRect, drawShape, fileName, hitHandle, inside, markText, paintMark, rectFrom, resizeRect, textSize, toolbarPlacement, worthKeeping,
  HANDLES, handlePoint, snapAngle, squareTo, type Handle, type Pt, type Rect, type Shape, type Tool,
} from './shapes.ts';
import { t } from '../i18n.ts';

/**
 * Screenshot: the page freezes under a dim layer reading "Select an area". Drag to choose a region (or click a pane to take it whole),
 * adjust it by its handles, mark it up (pen, line, arrow, rectangle, highlighter, text) or hide what should not be shared (pixelate,
 * blur), then copy it to the clipboard or save it as a PNG. One floating toolbar carries everything; every control has a tooltip and a
 * key. The picture is made by `capture.ts` from the page itself, so nothing is asked of the browser and nothing leaves the machine.
 */

const ICONS: Readonly<Record<Tool | 'undo' | 'redo' | 'copy' | 'save' | 'share' | 'link' | 'close', string>> = {
  move: '<path d="M5 3l14 8-6 1.5L10.5 19z"/>',
  pen: '<path d="M4 20l1-4L16.5 4.5a2 2 0 013 3L8 19z"/><path d="M14.5 6.5l3 3"/>',
  line: '<path d="M5 19L19 5"/>',
  arrow: '<path d="M5 19L18 6"/><path d="M10 6h8v8"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
  marker: '<path d="M9 14l6-6 3 3-6 6z"/><path d="M9 14l-2 4 4-1"/><path d="M4 21h16" stroke-width="3" opacity=".45"/>',
  text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  pixelate: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h16M12 4v16M8 4v16M16 4v16M4 8h16M4 16h16" opacity=".5"/>',
  blur: '<path d="M12 3c3.5 4.4 6 7.4 6 10.5a6 6 0 01-12 0C6 10.400 8.500 7.400 12 3z"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a5 5 0 010 10h-3"/>',
  redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a5 5 0 000 10h3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  save: '<path d="M12 4v11M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M6 12v6a2 2 0 002 2h8a2 2 0 002-2v-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const icon = (name: keyof typeof ICONS): string => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const TOOLS: { tool: Tool; label: string; key: string; hint: string }[] = [
  { tool: 'move', label: t('Move and resize'), key: 'V', hint: t('Drag the selection to move it, or its handles to resize it') },
  { tool: 'pen', label: t('Pen'), key: 'P', hint: t('Draw freehand') },
  { tool: 'line', label: t('Line'), key: 'L', hint: t('Drag to draw a straight line') },
  { tool: 'arrow', label: t('Arrow'), key: 'A', hint: t('Drag from the tail to the point') },
  { tool: 'rect', label: t('Rectangle'), key: 'R', hint: t('Drag to outline an area') },
  { tool: 'marker', label: t('Highlighter'), key: 'H', hint: t('Draw over something to highlight it') },
  { tool: 'text', label: t('Text'), key: 'T', hint: t('Click where the text should go; Enter to place it') },
  { tool: 'pixelate', label: t('Pixelate'), key: 'X', hint: t('Drag over anything that should not be shared: it turns into blocks') },
  { tool: 'blur', label: t('Blur'), key: 'B', hint: t('Drag over anything that should not be shared: it turns into a soft blur') },
];

/** Whether this browser can hand a picture to the system's share sheet, and a finger is what is pointing (a desktop has the clipboard and a download). */
function canShareFiles(): boolean {
  if (!isCoarse() || typeof navigator === 'undefined' || typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') return false;
  try { return navigator.canShare({ files: [new File([new Blob()], 'a.png', { type: 'image/png' })] }); } catch { return false; }
}

let active: { close(): void } | null = null;

/** Freeze the page and start the selection. Calling it while it is open closes it. */
export function startScreenshot(): void {
  if (active) { active.close(); return; }
  const snap = capturePage();
  active = openEditor(snap);
}

function openEditor(snap: Snapshot): { close(): void } {
  const W = snap.width, H = snap.height, scale = snap.scale;
  const dialog = el('dialog', { class: 'shot', ariaLabel: t('Screenshot') });
  const stage = el('canvas', { class: 'shot-stage' });
  stage.width = Math.round(W * scale); stage.height = Math.round(H * scale);
  stage.style.width = `${W}px`; stage.style.height = `${H}px`;
  // A finger drags and taps; a mouse drags and clicks and has Esc. The handles and the hit area around them are larger under a finger.
  const touch = isCoarse(), handleSize = touch ? 15 : 9, handleReach = touch ? 26 : 9;
  const hint = el('div', { class: 'shot-hint' }, el('strong', { textContent: t('Select an area') }),
    el('span', { textContent: touch ? t('Drag to choose a region · tap a pane to take all of it') : t('Drag to choose a region · click a pane to take all of it · Esc to cancel') }));
  const bar = el('div', { class: 'shot-bar', hidden: true, role: 'toolbar', ariaLabel: t('Screenshot tools') });
  dialog.append(stage, hint, bar);
  document.body.append(dialog);
  dialog.showModal();
  const ctx = stage.getContext('2d')!;

  // The panes that can be taken whole, found now while the page is as it was captured.
  const snapTargets: { rect: Rect; label: string }[] = [];
  for (const [selector, label] of [['.pane.heat', t('Click to take the chart')], ['.pane.depth', t('Click to take Depth')], ['.pane.oi', t('Click to take Open interest')], ['.pane.lt', t('Click to take the Liquidity Tracker')], ['.pane.bars', t('Click to take Bar stats')], ['.side-col', t('Click to take the order book')], ['.pane.cvd', t('Click to take the flow column')]] as const) {
    const node = document.querySelector(selector) as HTMLElement | null; if (!node || node.hidden) continue;
    const r = node.getBoundingClientRect();
    if (r.width > 40 && r.height > 20) snapTargets.push({ rect: { x: r.left, y: r.top, w: r.width, h: r.height }, label });
  }
  // Anything on the page that is not a pane (above all the top bar, which is not a picture worth taking alone) takes the whole page: every pane that is open.
  snapTargets.push({ rect: { x: 0, y: 0, w: W, h: H }, label: t('Click to take the whole page') });

  let sel: Rect | null = null;
  // A small mark with the page's address in a corner of the picture, on unless it was switched off (and that is remembered).
  const MARK_KEY = 'hlm-shot-mark', address = markText(AUTHOR.site);
  let withMark = (() => { try { return window.localStorage.getItem(MARK_KEY) !== 'off'; } catch { return true; } })();
  let tool: Tool = 'move', color = COLORS[0]!, width = WIDTHS[1]!, strength = 12;
  const shapes: Shape[] = [], redo: Shape[] = [];
  let draft: Shape | null = null, effectFrom: Pt = { x: 0, y: 0 };
  let hover: Pt | null = null, hoverTarget: { rect: Rect; label: string } | null = null;
  let drag: { kind: 'new'; from: Pt } | { kind: 'move'; from: Pt; start: Rect } | { kind: 'resize'; handle: Handle } | { kind: 'draw' } | null = null;
  let textBox: HTMLInputElement | null = null;
  let frame = 0, closed = false;

  const toast = (message: string): void => {
    const node = el('div', { class: 'shot-toast', textContent: message, role: 'status' });
    document.body.append(node); window.setTimeout(() => node.remove(), 2400);
  };

  // ---- drawing ----------------------------------------------------------------------------------------------------------------------
  const rounded = (x: number, y: number, w: number, h: number, r: number): void => { ctx.beginPath(); if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
  const paint = (): void => {
    frame = 0; if (closed) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, stage.width, stage.height);
    ctx.drawImage(snap.canvas, 0, 0);
    const area = sel ?? (drag?.kind === 'new' && hover ? rectFrom(drag.from, hover) : null);
    ctx.save(); ctx.scale(scale, scale);
    const dim = (x: number, y: number, w: number, h: number): void => { ctx.fillStyle = 'rgba(8, 10, 14, 0.58)'; ctx.fillRect(x, y, w, h); };
    if (!area) {
      dim(0, 0, W, H);
      if (hoverTarget) {
        const r = hoverTarget.rect;
        ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip(); ctx.drawImage(snap.canvas, 0, 0, W, H); ctx.restore();
        ctx.strokeStyle = '#4da3ff'; ctx.lineWidth = 2; ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
        const text = hoverTarget.label; ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
        const tw = ctx.measureText(text).width + 16, bx = Math.min(Math.max(r.x + 8, 4), W - tw - 4), by = Math.max(r.y + 8, 4);
        ctx.fillStyle = '#4da3ff'; rounded(bx, by, tw, 22, 6); ctx.fill();
        ctx.fillStyle = '#06101f'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + 8, by + 11.5);
      }
    } else {
      dim(0, 0, W, area.y); dim(0, area.y + area.h, W, H - area.y - area.h); dim(0, area.y, area.x, area.h); dim(area.x + area.w, area.y, W - area.x - area.w, area.h);
    }
    ctx.restore();
    if (!area) return;
    // The marks live in screen coordinates (so a selection can be resized afterwards without dragging them along) and are cut off at its edge.
    ctx.save(); ctx.beginPath(); ctx.rect(area.x * scale, area.y * scale, area.w * scale, area.h * scale); ctx.clip();
    for (const shape of draft ? [...shapes, draft] : shapes) drawShape(ctx, shape, snap.canvas, scale);
    ctx.restore();
    if (withMark) { ctx.save(); ctx.scale(scale, scale); paintMark(ctx, area, address); ctx.restore(); }
    ctx.save(); ctx.scale(scale, scale);
    // A dark line under a white dashed one reads on any background.
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeRect(area.x - 0.5, area.y - 0.5, area.w + 1, area.h + 1);
    ctx.strokeStyle = '#fff'; ctx.setLineDash([5, 4]); ctx.strokeRect(area.x - 0.5, area.y - 0.5, area.w + 1, area.h + 1); ctx.setLineDash([]);
    const label = `${Math.round(area.w)} × ${Math.round(area.h)}`; ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    const lw = ctx.measureText(label).width + 14, ly = area.y >= 28 ? area.y - 26 : area.y + 6;
    ctx.fillStyle = 'rgba(12,14,18,.9)'; rounded(area.x, ly, lw, 20, 5); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, area.x + 7, ly + 10.5);
    if (sel && tool === 'move') {
      for (const h of HANDLES) { const q = handlePoint(sel, h); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#111'; ctx.lineWidth = 1.2; rounded(q.x - handleSize / 2, q.y - handleSize / 2, handleSize, handleSize, 3); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
  };
  const redraw = (): void => { if (!frame && !closed) frame = requestAnimationFrame(paint); };

  // ---- the toolbar ------------------------------------------------------------------------------------------------------------------
  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const colorDots: HTMLButtonElement[] = [], widthDots: HTMLButtonElement[] = [];
  const group = (...children: HTMLElement[]): HTMLElement => el('div', { class: 'shot-group' }, ...children);
  const iconButton = (name: keyof typeof ICONS, tipText: string, onclick: () => void, extra = ''): HTMLButtonElement => {
    const b = el('button', { type: 'button', class: `shot-btn ${extra}`.trim(), tip: tipText, ariaLabel: tipText.split(' — ')[0]!, onclick }); b.innerHTML = icon(name); return b;
  };
  for (const t of TOOLS) { const b = iconButton(t.tool, `${t.label} (${t.key}) — ${t.hint}`, () => chooseTool(t.tool)); toolButtons.set(t.tool, b); }
  const tools = group(...[...toolButtons.values()]);
  const colors = group(...COLORS.map(c => { const b = el('button', { type: 'button', class: 'shot-dot', tip: t('Colour {c}', { c }), ariaLabel: t('Colour {c}', { c }), onclick: () => { color = c; syncBar(); redraw(); } }); b.style.setProperty('--dot', c); colorDots.push(b); return b; }));
  const widths = group(...WIDTHS.map((w, i) => { const b = el('button', { type: 'button', class: 'shot-width', tip: [t('Thin stroke'), t('Medium stroke'), t('Thick stroke')][i]!, ariaLabel: [t('Thin stroke'), t('Medium stroke'), t('Thick stroke')][i]!, onclick: () => { width = w; syncBar(); } }); b.style.setProperty('--w', `${2 + i * 2.5}px`); widthDots.push(b); return b; }));
  const strengthInput = el('input', { type: 'range', min: '4', max: '40', step: '1', value: String(strength), tip: t('How strong the effect is'), ariaLabel: t('Effect strength'), oninput: () => { strength = Number(strengthInput.value); } });
  const strengthGroup = group(el('span', { class: 'shot-label', textContent: t('Strength') }), strengthInput);
  const undoButton = iconButton('undo', t('Undo (Ctrl+Z)'), () => undo()), redoButton = iconButton('redo', t('Redo (Ctrl+Shift+Z)'), () => redoShape());
  const copyButton = el('button', { type: 'button', class: 'shot-primary', tip: t('Copy the picture to the clipboard (Enter)'), onclick: () => void copy() }); copyButton.innerHTML = `${icon('copy')}<span>${t('Copy')}</span>`;
  const markButton = iconButton('link', '', () => { withMark = !withMark; try { window.localStorage.setItem(MARK_KEY, withMark ? 'on' : 'off'); } catch { /* storage unavailable */ } syncBar(); redraw(); });
  const saveButton = iconButton('save', t('Save as a PNG file (Ctrl+S)'), () => void save()), closeButton = iconButton('close', t('Cancel (Esc)'), () => close(), 'shot-close');
  // A phone shares a picture through its own sheet (Messages, Photos, Files...); that is better than a download no one can find there.
  const shareButton = canShareFiles() ? iconButton('share', t('Share the picture with another app'), () => void share()) : null;
  bar.append(tools, colors, widths, strengthGroup, group(undoButton, redoButton), group(markButton, copyButton, ...(shareButton ? [shareButton] : []), saveButton, closeButton));

  const syncBar = (): void => {
    for (const [t, b] of toolButtons) b.classList.toggle('on', t === tool);
    colorDots.forEach((b, i) => b.classList.toggle('on', COLORS[i] === color)); widthDots.forEach((b, i) => b.classList.toggle('on', WIDTHS[i] === width));
    const draws = tool !== 'move' && tool !== 'pixelate' && tool !== 'blur', effect = tool === 'pixelate' || tool === 'blur';
    colors.hidden = !draws; widths.hidden = !draws; strengthGroup.hidden = !effect;
    undoButton.disabled = shapes.length === 0; redoButton.disabled = redo.length === 0;
    markButton.classList.toggle('on', withMark);
    setTip(markButton, withMark ? t('Put {address} in a corner of the picture (on): click to leave it out', { address }) : t('Leave the address out of the picture (off): click to put {address} in a corner', { address }));
    markButton.setAttribute('aria-pressed', String(withMark)); markButton.setAttribute('aria-label', withMark ? t('Address in a corner of the picture: on') : t('Address in a corner of the picture: off'));
    stage.style.cursor = sel ? (tool === 'move' ? 'default' : tool === 'text' ? 'text' : 'crosshair') : 'crosshair';
    place();
  };
  const place = (): void => {
    if (!sel) { bar.hidden = true; return; }
    bar.hidden = false;
    const at = toolbarPlacement(sel, { w: bar.offsetWidth || 560, h: bar.offsetHeight || 52 }, { w: W, h: H });
    bar.style.left = `${Math.round(at.x)}px`; bar.style.top = `${Math.round(at.y)}px`;
  };
  const chooseTool = (next: Tool): void => { commitText(); tool = next; syncBar(); redraw(); };

  // ---- actions ----------------------------------------------------------------------------------------------------------------------
  const render = (): HTMLCanvasElement | null => {
    if (!sel) return null;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sel.w * scale)); out.height = Math.max(1, Math.round(sel.h * scale));
    const o = out.getContext('2d')!;
    o.drawImage(snap.canvas, sel.x * scale, sel.y * scale, sel.w * scale, sel.h * scale, 0, 0, out.width, out.height);
    o.save(); o.translate(-sel.x * scale, -sel.y * scale);
    for (const shape of shapes) drawShape(o, shape, snap.canvas, scale);
    o.restore();
    if (withMark) { o.save(); o.scale(scale, scale); paintMark(o, { x: 0, y: 0, w: sel.w, h: sel.h }, address); o.restore(); }
    return out;
  };
  const blob = (): Promise<Blob | null> => new Promise(resolve => { const out = render(); if (!out) resolve(null); else out.toBlob(b => resolve(b), 'image/png'); });
  const download = (data: Blob): void => {
    const url = URL.createObjectURL(data), a = el('a', { href: url, download: fileName(new Date()) });
    document.body.append(a); a.click(); a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  async function copy(): Promise<void> {
    commitText();
    if (!sel) return;
    const pending = blob();
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pending.then(b => b ?? Promise.reject(new Error('no picture'))) })]);
      close(); toast(t('Copied to the clipboard'));
    } catch {
      // No clipboard permission (or a context without one): the picture must not be lost, so it is saved instead.
      const data = await pending; if (data) { download(data); close(); toast(t('Could not copy here, so it was saved as a file')); }
    }
  }
  async function share(): Promise<void> {
    commitText();
    const data = await blob(); if (!data) return;
    try {
      await navigator.share({ files: [new File([data], fileName(new Date()), { type: 'image/png' })], title: 'LiquidityMapperFast' });
      close(); toast(t('Shared'));
    } catch (error) {
      // Dismissing the share sheet is not a failure: the picture stays open for another try.
      if (!(error instanceof DOMException && error.name === 'AbortError')) { download(data); close(); toast(t('Could not share here, so it was saved as a file')); }
    }
  }
  async function save(): Promise<void> { commitText(); const data = await blob(); if (data) { download(data); close(); toast(t('Saved')); } }
  function undo(): void { commitText(); const s = shapes.pop(); if (s) { redo.push(s); syncBar(); redraw(); } }
  function redoShape(): void { const s = redo.pop(); if (s) { shapes.push(s); syncBar(); redraw(); } }
  function close(): void {
    if (closed) return; closed = true; active = null;
    document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize);
    if (frame) cancelAnimationFrame(frame);
    textBox?.remove(); dialog.close(); dialog.remove();
  }

  // ---- text -------------------------------------------------------------------------------------------------------------------------
  const startText = (at: Pt): void => {
    commitText();
    const size = textSize(width), input = el('input', { type: 'text', class: 'shot-text', ariaLabel: t('Text to place'), spellcheck: false });
    input.style.left = `${at.x}px`; input.style.top = `${at.y}px`; input.style.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`; input.style.color = color; input.style.height = `${Math.round(size * 1.3)}px`;
    input.dataset.size = String(size); input.dataset.color = color;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitText(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); textBox?.remove(); textBox = null; } e.stopPropagation(); });
    dialog.append(input); textBox = input; input.focus();
  };
  function commitText(): void {
    const input = textBox; if (!input) return; textBox = null;
    const text = input.value, at = { x: parseFloat(input.style.left), y: parseFloat(input.style.top) }, size = Number(input.dataset.size), c = input.dataset.color!;
    input.remove();
    const shape: Shape = { kind: 'text', at, text, color: c, size };
    if (worthKeeping(shape)) { shapes.push(shape); redo.length = 0; syncBar(); redraw(); }
  }

  // ---- pointer ----------------------------------------------------------------------------------------------------------------------
  const local = (e: PointerEvent): Pt => { const r = stage.getBoundingClientRect(); return { x: Math.max(0, Math.min(e.clientX - r.left, W)), y: Math.max(0, Math.min(e.clientY - r.top, H)) }; };
  const targetAt = (p: Pt): { rect: Rect; label: string } | null => {
    let best: { rect: Rect; label: string } | null = null;
    for (const t of snapTargets) if (inside(t.rect, p) && (!best || t.rect.w * t.rect.h < best.rect.w * best.rect.h)) best = t;
    return best;
  };
  /** Grow the shape being drawn to the pointer. Shift keeps a rectangle square and a line on a multiple of 45 degrees. */
  const extend = (d: Shape, q: Pt, shift: boolean): void => {
    switch (d.kind) {
      case 'pen': case 'marker': d.points.push(q); return;
      case 'pixelate': case 'blur': d.rect = rectFrom(effectFrom, q); return;
      case 'rect': d.b = shift ? squareTo(d.a, q) : q; return;
      case 'line': case 'arrow': d.b = shift ? snapAngle(d.a, q) : q; return;
      case 'text': return;
    }
  };
  stage.addEventListener('pointerdown', e => {
    if (e.button === 2) return;
    const p = local(e);
    if (textBox && tool === 'text') commitText();
    if (sel && tool !== 'move') {
      if (!inside(sel, p)) return;
      if (tool === 'text') { startText(p); e.preventDefault(); return; }
      stage.setPointerCapture(e.pointerId); drag = { kind: 'draw' };
      const first = { ...p }; effectFrom = first;
      draft = tool === 'pen' || tool === 'marker' ? { kind: tool, points: [first], color, width }
        : tool === 'pixelate' || tool === 'blur' ? { kind: tool, rect: { x: p.x, y: p.y, w: 0, h: 0 }, strength }
        : { kind: tool as 'line' | 'arrow' | 'rect', a: first, b: first, color, width };
      return;
    }
    stage.setPointerCapture(e.pointerId);
    if (sel) {
      const handle = hitHandle(sel, p, handleReach);
      if (handle) { drag = { kind: 'resize', handle }; return; }
      if (inside(sel, p)) { drag = { kind: 'move', from: p, start: { ...sel } }; return; }
    }
    sel = null; bar.hidden = true; hint.hidden = true; drag = { kind: 'new', from: p }; hover = p; redraw();
  });
  stage.addEventListener('pointermove', e => {
    const p = local(e); hover = p;
    if (!drag) {
      if (!sel) { hoverTarget = targetAt(p); hint.style.opacity = hoverTarget ? '0' : ''; }
      else if (tool === 'move') { const h = hitHandle(sel, p, handleReach); stage.style.cursor = h ? CURSORS[h] : inside(sel, p) ? 'move' : 'crosshair'; }
      redraw(); return;
    }
    if (drag.kind === 'new') { hint.hidden = true; redraw(); }
    else if (drag.kind === 'move' && sel) { sel = clampRect({ ...drag.start, x: drag.start.x + p.x - drag.from.x, y: drag.start.y + p.y - drag.from.y }, { w: W, h: H }); place(); redraw(); }
    else if (drag.kind === 'resize' && sel) { sel = resizeRect(sel, drag.handle, p, { w: W, h: H }); place(); redraw(); }
    else if (drag.kind === 'draw' && draft && sel) {
      const q = { x: Math.max(sel.x, Math.min(p.x, sel.x + sel.w)), y: Math.max(sel.y, Math.min(p.y, sel.y + sel.h)) };
      extend(draft, q, e.shiftKey);
      redraw();
    }
  });
  stage.addEventListener('pointerup', e => {
    const p = local(e); const d = drag; drag = null;
    if (!d) return;
    if (d.kind === 'new') {
      const r = rectFrom(d.from, p);
      if (r.w >= 6 && r.h >= 6) sel = r;
      else { const t = targetAt(p); if (t) sel = { ...t.rect }; }
      if (sel) { tool = 'move'; syncBar(); } else hint.hidden = false;
      redraw();
    } else if (d.kind === 'draw' && draft) {
      if (worthKeeping(draft)) { shapes.push(draft); redo.length = 0; }
      draft = null; syncBar(); redraw();
    } else syncBar();
  });
  stage.addEventListener('pointerleave', () => { hover = null; hoverTarget = null; redraw(); });
  stage.addEventListener('contextmenu', e => { e.preventDefault(); if (sel || shapes.length) { sel = null; shapes.length = 0; redo.length = 0; draft = null; textBox?.remove(); textBox = null; bar.hidden = true; hint.hidden = false; redraw(); } else close(); });

  // ---- keys -------------------------------------------------------------------------------------------------------------------------
  function onKey(e: KeyboardEvent): void {
    if (closed || (e.target instanceof HTMLInputElement && e.target.classList.contains('shot-text'))) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Enter' && sel) { e.preventDefault(); void copy(); return; }
    if (mod && k === 'c' && sel) { e.preventDefault(); void copy(); return; }
    if (mod && k === 's' && sel) { e.preventDefault(); void save(); return; }
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redoShape(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redoShape(); return; }
    if (!mod && !e.altKey && sel) { const t = TOOLS.find(x => x.key.toLowerCase() === k); if (t) { e.preventDefault(); chooseTool(t.tool); } }
  }
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  document.addEventListener('keydown', onKey, true);
  // The frozen picture is of the window as it was: a different width (a rotation) makes it wrong, but a phone's address bar sliding away only changes the height a little.
  const onResize = (): void => { if (Math.abs(window.innerWidth - W) > 1 || Math.abs(window.innerHeight - H) > 120) close(); };
  window.addEventListener('resize', onResize);
  syncBar(); paint();
  return { close };
}
