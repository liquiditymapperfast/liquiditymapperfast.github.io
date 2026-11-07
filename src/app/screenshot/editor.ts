import { el } from '../dom.ts';
import { isCoarse } from '../device.ts';
import { AUTHOR } from '../author.ts';
import { setTip } from '../tip.ts';
import { timeZone } from '../format.ts';
import { capturePageReady, type Snapshot } from './capture.ts';
import {
  BLOCK_BORDERS, BLOCK_FILL_START, BLOCK_SIZE, COLORS, CURSORS, WIDTHS, clampRect, drawShape, fileName, hitHandle, inside, markText, paintMark, rectFrom, resizeRect, textSize, toolbarPlacement, worthKeeping,
  HANDLES, handlePoint, snapAngle, squareTo, type BlockBorder, type Handle, type Pt, type Rect, type Shape, type Tool,
} from './shapes.ts';
import { GIF_LIMIT, GIF_SECONDS, planGif } from './gif-budget.ts';
import { recordGif, type GifRecording, type GifResult } from './gif-record.ts';
import { language, t, tn } from '../i18n.ts';

/**
 * Screenshot: the page freezes under a dim layer reading "Select an area". Drag to choose a region (or click a pane to take it whole),
 * adjust it by its handles, mark it up (pen, line, arrow, rectangle, highlighter, text) or hide what should not be shared (pixelate,
 * blur), then copy it to the clipboard or save it as a PNG. One floating toolbar carries everything; every control has a tooltip and a
 * key. The picture is made by `capture.ts` from the page itself, so nothing is asked of the browser and nothing leaves the machine.
 *
 * The same area can be recorded as a GIF instead (the bar's GIF button, or G): a slider sets its length, from 1 to 15 seconds, and
 * Record shows the live page in the area while it records (`gif-record.ts`), the marks drawn on it burnt into every frame. The file is
 * kept under 15 MB so it can be posted (`gif-budget.ts`), and then saved, shared from a phone, or copied where the browser can copy a GIF.
 */

const ICONS: Readonly<Record<Tool | 'undo' | 'redo' | 'copy' | 'save' | 'share' | 'link' | 'close' | 'picture' | 'gif' | 'record' | 'stop' | 'again', string>> = {
  move: '<path d="M5 3l14 8-6 1.5L10.5 19z"/>',
  pen: '<path d="M4 20l1-4L16.5 4.5a2 2 0 013 3L8 19z"/><path d="M14.5 6.5l3 3"/>',
  line: '<path d="M5 19L19 5"/>',
  arrow: '<path d="M5 19L18 6"/><path d="M10 6h8v8"/>',
  block: '<path d="M3.5 9.5h9V5.5l8 6.5-8 6.5v-4h-9z"/>',
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
  picture: '<path d="M4 8.5h3.2l1.8-2.5h6l1.8 2.5H20V19H4z"/><circle cx="12" cy="13.5" r="3.3"/>',
  gif: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M3.5 8.5h17M3.5 15.5h17M7.5 5v3.5M12 5v3.5M16.5 5v3.5M7.5 15.5V19M12 15.5V19M16.5 15.5V19" opacity=".6"/><path d="M10.5 10.3v3.4l3-1.7z" fill="currentColor"/>',
  record: '<circle cx="12" cy="12" r="5.5" fill="currentColor" stroke="none"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
  again: '<path d="M19 12a7 7 0 11-2.05-4.95"/><path d="M19.5 4.5v3.5H16"/>',
};
const icon = (name: keyof typeof ICONS): string => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const TOOLS: { tool: Tool; label: string; key: string; hint: string }[] = [
  { tool: 'move', label: t('Move and resize'), key: 'V', hint: t('Drag the selection to move it, or its handles to resize it') },
  { tool: 'pen', label: t('Pen'), key: 'P', hint: t('Draw freehand') },
  { tool: 'line', label: t('Line'), key: 'L', hint: t('Drag to draw a straight line') },
  { tool: 'arrow', label: t('Arrow'), key: 'A', hint: t('Drag from the tail to the point') },
  { tool: 'block', label: t('Block arrow'), key: 'F', hint: t('Drag from the tail to the point: a wide arrow, filled, see-through or empty, with a border or without') },
  { tool: 'rect', label: t('Rectangle'), key: 'R', hint: t('Drag to outline an area') },
  { tool: 'marker', label: t('Highlighter'), key: 'H', hint: t('Draw over something to highlight it') },
  { tool: 'text', label: t('Text'), key: 'T', hint: t('Click where the text should go; Enter to place it') },
  { tool: 'pixelate', label: t('Pixelate'), key: 'X', hint: t('Drag over anything that should not be shared: it turns into blocks') },
  { tool: 'blur', label: t('Blur'), key: 'B', hint: t('Drag over anything that should not be shared: it turns into a soft blur') },
];

/** Whether this browser can hand a file of `type` to the system's share sheet, and a finger is what is pointing (a desktop has the clipboard and a download). */
function canShareFiles(type = 'image/png', name = 'a.png'): boolean {
  if (!isCoarse() || typeof navigator === 'undefined' || typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') return false;
  try { return navigator.canShare({ files: [new File([new Blob()], name, { type })] }); } catch { return false; }
}

/**
 * Whether the clipboard takes a GIF. Browsers copy pictures as PNG only (Chrome's `ClipboardItem.supports('image/gif')` is false), and a
 * GIF turned into a PNG would stand still, so Copy is offered only where the browser says it takes one.
 */
function canCopyGif(): boolean {
  const item = typeof ClipboardItem === 'undefined' ? null : ClipboardItem as unknown as { supports?: (type: string) => boolean };
  try { return !!item && typeof item.supports === 'function' && item.supports('image/gif') && typeof navigator.clipboard?.write === 'function'; } catch { return false; }
}

const LENGTH_KEY = 'hlm-shot-gif-seconds';
/** The tolerance (levels) from which a GIF says that its faintest changes were left out. */
const FAINT_TOLERANCE = 8;

let active: { close(): void } | null = null, starting = false;

/**
 * Freeze the page and start the selection. Calling it while it is open closes it. The first picture after the page opens waits a moment
 * for the icons' mask pictures to be read (`capturePageReady`); asked again meanwhile, it is not started twice.
 */
export async function startScreenshot(): Promise<void> {
  if (active) { active.close(); return; }
  if (starting) return;
  starting = true;
  try { const snap = await capturePageReady(); if (!active) active = openEditor(snap); } finally { starting = false; }
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
  // The finished GIF plays over the area it was recorded from.
  const preview = el('img', { class: 'shot-preview', alt: '', hidden: true });
  dialog.append(stage, preview, hint, bar);
  document.body.append(dialog);
  dialog.showModal();
  const ctx = stage.getContext('2d')!;

  // The panes that can be taken whole, found now while the page is as it was captured: those named here, then any other pane (one added
  // later is never left out, as Delta and L/S were).
  const snapTargets: { rect: Rect; label: string }[] = [], named = new Set<Element>();
  const take = (node: HTMLElement, label: string): void => {
    named.add(node); if (node.hidden) return;
    const r = node.getBoundingClientRect();
    if (r.width > 40 && r.height > 20) snapTargets.push({ rect: { x: r.left, y: r.top, w: r.width, h: r.height }, label });
  };
  for (const [selector, label] of [['.pane.heat', t('Click to take the chart')], ['.pane.depth', t('Click to take Depth')], ['.pane.oi', t('Click to take Open interest')], ['.pane.delta', t('Click to take Delta')], ['.pane.ls', t('Click to take Long/Short')], ['.pane.lt', t('Click to take the Liquidity Tracker')], ['.pane.bars', t('Click to take Bar stats')], ['.pane.ladder', t('Click to take the order book')], ['.pane.cvd', t('Click to take the flow column')]] as const) {
    const node = document.querySelector(selector) as HTMLElement | null; if (node) take(node, label);
  }
  for (const node of document.querySelectorAll<HTMLElement>('.pane')) if (!named.has(node)) take(node, t('Click to take this pane'));
  // Anything on the page that is not a pane (above all the top bar, which is not a picture worth taking alone) takes the whole page: every pane that is open.
  snapTargets.push({ rect: { x: 0, y: 0, w: W, h: H }, label: t('Click to take the whole page') });

  let sel: Rect | null = null;
  // A small mark with the page's address in a corner of the picture, on unless it was switched off (and that is remembered).
  const MARK_KEY = 'hlm-shot-mark', address = markText(AUTHOR.site);
  let withMark = (() => { try { return window.localStorage.getItem(MARK_KEY) !== 'off'; } catch { return true; } })();
  let tool: Tool = 'move', color = COLORS[0]!, width = WIDTHS[1]!, strength = 12;
  // The block arrow's own settings: how wide, how much it is filled, and its edge.
  let blockSize: number = BLOCK_SIZE.start, blockFill = BLOCK_FILL_START, blockBorder: BlockBorder = 'color';
  const shapes: Shape[] = [], redo: Shape[] = [];
  let draft: Shape | null = null, effectFrom: Pt = { x: 0, y: 0 };
  let hover: Pt | null = null, hoverTarget: { rect: Rect; label: string } | null = null;
  let drag: { kind: 'new'; from: Pt } | { kind: 'move'; from: Pt; start: Rect } | { kind: 'resize'; handle: Handle } | { kind: 'draw' } | null = null;
  let textBox: HTMLInputElement | null = null;
  let frame = 0, closed = false;
  // A picture or a GIF; for a GIF, where it is: being set up, starting, recording, being finished, or ready.
  let mode: 'picture' | 'gif' = 'picture', phase: 'setup' | 'starting' | 'recording' | 'finishing' | 'ready' = 'setup';
  let seconds: number = (() => { try { const n = Number(window.localStorage.getItem(LENGTH_KEY)); return n >= GIF_SECONDS.min && n <= GIF_SECONDS.max ? Math.round(n) : GIF_SECONDS.start; } catch { return GIF_SECONDS.start; } })();
  let recording: GifRecording | null = null, gif: GifResult | null = null, gifUrl: string | null = null, stopAsked = false;
  const busy = (): boolean => mode === 'gif' && phase !== 'setup';

  const toast = (message: string): void => {
    const node = el('div', { class: 'shot-toast', textContent: message, role: 'status' });
    document.body.append(node); window.setTimeout(() => node.remove(), 2400);
  };
  const decimal = new Intl.NumberFormat(language(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const mb = (bytes: number): string => t('{n} MB', { n: decimal.format(bytes / 1e6) });

  // ---- drawing ----------------------------------------------------------------------------------------------------------------------
  const rounded = (x: number, y: number, w: number, h: number, r: number): void => { ctx.beginPath(); if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
  const paint = (): void => {
    frame = 0; if (closed) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, stage.width, stage.height);
    ctx.drawImage(snap.canvas, 0, 0);
    const area = sel ?? (drag?.kind === 'new' && hover ? rectFrom(drag.from, hover) : null);
    // While a GIF records, the area shows the page itself, live, through a hole in the frozen picture.
    const live = mode === 'gif' && (phase === 'starting' || phase === 'recording' || phase === 'finishing') && sel !== null;
    if (live && sel) ctx.clearRect(sel.x * scale, sel.y * scale, sel.w * scale, sel.h * scale);
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
    if (!live && !(mode === 'gif' && phase === 'ready')) {
      // The marks live in screen coordinates (so a selection can be resized afterwards without dragging them along) and are cut off at its edge.
      ctx.save(); ctx.beginPath(); ctx.rect(area.x * scale, area.y * scale, area.w * scale, area.h * scale); ctx.clip();
      for (const shape of draft ? [...shapes, draft] : shapes) drawShape(ctx, shape, snap.canvas, scale);
      ctx.restore();
      if (withMark) { ctx.save(); ctx.scale(scale, scale); paintMark(ctx, area, address); ctx.restore(); }
    }
    ctx.save(); ctx.scale(scale, scale);
    // A dark line under a white dashed one reads on any background; a recording is outlined in red, solid.
    ctx.lineWidth = live ? 2 : 1; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeRect(area.x - 0.5, area.y - 0.5, area.w + 1, area.h + 1);
    if (live) { ctx.strokeStyle = '#ff453a'; ctx.strokeRect(area.x - 1.5, area.y - 1.5, area.w + 3, area.h + 3); }
    else { ctx.strokeStyle = '#fff'; ctx.setLineDash([5, 4]); ctx.strokeRect(area.x - 0.5, area.y - 0.5, area.w + 1, area.h + 1); ctx.setLineDash([]); }
    const label = `${Math.round(area.w)} × ${Math.round(area.h)}`; ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    const lw = ctx.measureText(label).width + 14, ly = area.y >= 28 ? area.y - 26 : area.y + 6;
    ctx.fillStyle = 'rgba(12,14,18,.9)'; rounded(area.x, ly, lw, 20, 5); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, area.x + 7, ly + 10.5);
    if (sel && tool === 'move' && !busy()) {
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
  const primary = (name: keyof typeof ICONS, text: string, tipText: string, onclick: () => void, extra = ''): HTMLButtonElement => {
    const b = el('button', { type: 'button', class: `shot-primary ${extra}`.trim(), tip: tipText, onclick }); b.innerHTML = `${icon(name)}<span>${text}</span>`; return b;
  };
  for (const t of TOOLS) { const b = iconButton(t.tool, `${t.label} (${t.key}) — ${t.hint}`, () => chooseTool(t.tool)); toolButtons.set(t.tool, b); }
  const tools = group(...[...toolButtons.values()]);
  const colors = group(...COLORS.map(c => { const b = el('button', { type: 'button', class: 'shot-dot', tip: t('Colour {c}', { c }), ariaLabel: t('Colour {c}', { c }), onclick: () => { color = c; syncBar(); redraw(); } }); b.style.setProperty('--dot', c); colorDots.push(b); return b; }));
  const widths = group(...WIDTHS.map((w, i) => { const b = el('button', { type: 'button', class: 'shot-width', tip: [t('Thin stroke'), t('Medium stroke'), t('Thick stroke')][i]!, ariaLabel: [t('Thin stroke'), t('Medium stroke'), t('Thick stroke')][i]!, onclick: () => { width = w; syncBar(); } }); b.style.setProperty('--w', `${2 + i * 2.5}px`); widthDots.push(b); return b; }));
  const strengthInput = el('input', { type: 'range', min: '4', max: '40', step: '1', value: String(strength), tip: t('How strong the effect is'), ariaLabel: t('Effect strength'), oninput: () => { strength = Number(strengthInput.value); } });
  const strengthGroup = group(el('span', { class: 'shot-label', textContent: t('Strength') }), strengthInput);
  const fillInput = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(Math.round(blockFill * 100)), tip: t('How much the arrow is filled: none (an outline), see-through, or solid'), ariaLabel: t('Arrow fill'), oninput: () => { blockFill = Number(fillInput.value) / 100; } });
  const sizeInput = el('input', { type: 'range', min: String(BLOCK_SIZE.min), max: String(BLOCK_SIZE.max), step: '2', value: String(blockSize), tip: t('How wide the arrow is'), ariaLabel: t('Arrow width'), oninput: () => { blockSize = Number(sizeInput.value); } });
  const borderNames: Readonly<Record<BlockBorder, string>> = { color: t('Border: its colour'), contrast: t('Border: contrasting'), none: t('No border') };
  const borderButton = el('button', { type: 'button', class: 'shot-toggle', tip: t('The arrow\'s edge: in its colour, a contrasting line, or none (click to change)'), onclick: () => { blockBorder = BLOCK_BORDERS[(BLOCK_BORDERS.indexOf(blockBorder) + 1) % BLOCK_BORDERS.length]!; syncBar(); } });
  const blockGroup = group(el('span', { class: 'shot-label', textContent: t('Fill') }), fillInput, el('span', { class: 'shot-label', textContent: t('Size') }), sizeInput, borderButton);
  const undoButton = iconButton('undo', t('Undo (Ctrl+Z)'), () => undo()), redoButton = iconButton('redo', t('Redo (Ctrl+Shift+Z)'), () => redoShape());
  const historyGroup = group(undoButton, redoButton);
  const copyButton = primary('copy', t('Copy'), t('Copy the picture to the clipboard (Enter)'), () => void copy());
  const markButton = iconButton('link', '', () => { withMark = !withMark; try { window.localStorage.setItem(MARK_KEY, withMark ? 'on' : 'off'); } catch { /* storage unavailable */ } syncBar(); redraw(); });
  const saveButton = iconButton('save', t('Save as a PNG file (Ctrl+S)'), () => void save()), closeButton = iconButton('close', t('Cancel (Esc)'), () => close(), 'shot-close');
  // A phone shares a picture through its own sheet (Messages, Photos, Files...); that is better than a download no one can find there.
  const shareButton = canShareFiles() ? iconButton('share', t('Share the picture with another app'), () => void share()) : null;
  const pictureActions = group(copyButton, ...(shareButton ? [shareButton] : []), saveButton);

  // A picture or a GIF: two buttons that choose, the pressed one being what Copy, Save or Record make.
  const pictureMode = iconButton('picture', t('Picture: copy or save the area as a PNG (G)'), () => chooseMode('picture'));
  const gifMode = iconButton('gif', t('GIF: record the area as it moves, up to {n} seconds (G)', { n: GIF_SECONDS.max }), () => chooseMode('gif'));
  const modeGroup = group(pictureMode, gifMode);

  // The GIF's length and what the area will make, then Record.
  const lengthInput = el('input', { type: 'range', min: String(GIF_SECONDS.min), max: String(GIF_SECONDS.max), step: '1', value: String(seconds), tip: t('How long the GIF is'), ariaLabel: t('GIF length in seconds'),
    oninput: () => { seconds = Number(lengthInput.value); try { window.localStorage.setItem(LENGTH_KEY, String(seconds)); } catch { /* storage unavailable */ } syncGif(); } });
  const lengthValue = el('span', { class: 'shot-value' });
  const planText = el('span', { class: 'shot-note' });
  const recordButton = primary('record', t('Record'), t('Record the area as a GIF (Enter)'), () => startGif(), 'shot-rec');
  const gifSetup = group(el('span', { class: 'shot-label', textContent: t('Length') }), lengthInput, lengthValue, planText, recordButton);

  // While recording: how far it is, and Stop.
  const progressFill = el('span', { class: 'shot-progress-fill' });
  const progress = el('span', { class: 'shot-progress', role: 'progressbar', ariaLabel: t('Recording') }, progressFill);
  const progressText = el('span', { class: 'shot-value shot-wide' });
  const stopButton = primary('stop', t('Stop'), t('Stop here: the GIF keeps what was recorded (Enter)'), () => stopGif(), 'shot-rec');
  const gifRecording = group(progress, progressText, stopButton);

  // A finished GIF: what it came to, and what can be done with it.
  const resultText = el('span', { class: 'shot-value shot-wide' });
  const shareGifButton = canShareFiles('image/gif', 'a.gif') ? iconButton('share', t('Share the GIF with another app'), () => void shareGif()) : null;
  const copyGifButton = canCopyGif() ? iconButton('copy', t('Copy the GIF to the clipboard (Ctrl+C)'), () => void copyGif()) : null;
  const saveGifButton = primary('save', t('Save GIF'), t('Save the GIF as a file (Ctrl+S)'), () => saveGif());
  const againButton = iconButton('again', t('Record again'), () => again());
  // Said where there is no copy, so nobody looks for one: what to do instead.
  const noCopy = copyGifButton || shareGifButton ? null : el('span', { class: 'shot-note', textContent: t('This browser cannot copy a GIF: save it, then attach the file') });
  const gifReady = group(resultText, ...(shareGifButton ? [shareGifButton] : []), ...(copyGifButton ? [copyGifButton] : []), saveGifButton, againButton, ...(noCopy ? [noCopy] : []));

  modeGroup.classList.add('shot-modes'); for (const g of [gifSetup, gifRecording, gifReady]) g.classList.add('shot-gif');
  bar.append(modeGroup, tools, colors, widths, blockGroup, strengthGroup, historyGroup, pictureActions, gifSetup, gifRecording, gifReady, group(markButton, closeButton));

  const syncBar = (): void => {
    for (const [t, b] of toolButtons) b.classList.toggle('on', t === tool);
    colorDots.forEach((b, i) => b.classList.toggle('on', COLORS[i] === color)); widthDots.forEach((b, i) => b.classList.toggle('on', WIDTHS[i] === width));
    const draws = tool !== 'move' && tool !== 'pixelate' && tool !== 'blur', effect = tool === 'pixelate' || tool === 'blur', marking = !busy();
    tools.hidden = !marking; historyGroup.hidden = !marking;
    colors.hidden = !draws || !marking; widths.hidden = !draws || !marking; strengthGroup.hidden = !effect || !marking; blockGroup.hidden = tool !== 'block' || !marking;
    borderButton.textContent = borderNames[blockBorder]; borderButton.setAttribute('aria-label', borderNames[blockBorder]);
    undoButton.disabled = shapes.length === 0; redoButton.disabled = redo.length === 0;
    pictureMode.classList.toggle('on', mode === 'picture'); gifMode.classList.toggle('on', mode === 'gif');
    pictureMode.setAttribute('aria-pressed', String(mode === 'picture')); gifMode.setAttribute('aria-pressed', String(mode === 'gif'));
    modeGroup.hidden = busy();
    pictureActions.hidden = mode !== 'picture';
    gifSetup.hidden = mode !== 'gif' || phase !== 'setup';
    gifRecording.hidden = mode !== 'gif' || (phase !== 'starting' && phase !== 'recording' && phase !== 'finishing');
    gifReady.hidden = mode !== 'gif' || phase !== 'ready';
    markButton.hidden = busy();
    markButton.classList.toggle('on', withMark);
    setTip(markButton, withMark ? t('Put {address} in a corner of the picture (on): click to leave it out', { address }) : t('Leave the address out of the picture (off): click to put {address} in a corner', { address }));
    markButton.setAttribute('aria-pressed', String(withMark)); markButton.setAttribute('aria-label', withMark ? t('Address in a corner of the picture: on') : t('Address in a corner of the picture: off'));
    stage.style.cursor = busy() ? 'default' : sel ? (tool === 'move' ? 'default' : tool === 'text' ? 'text' : 'crosshair') : 'crosshair';
    syncGif();
    place();
  };
  /** The GIF's words: its length, what the area will make, and how far a recording is. */
  const syncGif = (): void => {
    lengthValue.textContent = t('{n} s', { n: seconds });
    if (sel && phase === 'setup') {
      const plan = planGif(sel.w, sel.h, seconds, window.devicePixelRatio || 1);
      planText.textContent = t('{fps} fps, {w} × {h} px', { fps: plan.fps, w: plan.width, h: plan.height });
      setTip(planText, t('The GIF is kept under {mb} MB so it can be posted: a larger area or a longer GIF gets fewer frames a second or fewer pixels', { mb: GIF_LIMIT / 1e6 }));
    }
  };
  const place = (): void => {
    if (!sel) { bar.hidden = true; return; }
    bar.hidden = false;
    const at = toolbarPlacement(sel, { w: bar.offsetWidth || 560, h: bar.offsetHeight || 52 }, { w: W, h: H });
    bar.style.left = `${Math.round(at.x)}px`; bar.style.top = `${Math.round(at.y)}px`;
  };
  const chooseTool = (next: Tool): void => { commitText(); tool = next; syncBar(); redraw(); };
  const chooseMode = (next: 'picture' | 'gif'): void => { if (busy()) return; commitText(); mode = next; phase = 'setup'; syncBar(); redraw(); };

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
  const download = (data: Blob, extension: 'png' | 'gif' = 'png'): void => {
    const url = URL.createObjectURL(data), a = el('a', { href: url, download: fileName(new Date(), timeZone() === 'utc', extension) });
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
      await navigator.share({ files: [new File([data], fileName(new Date(), timeZone() === 'utc'), { type: 'image/png' })], title: 'LiquidityMapperFast' });
      close(); toast(t('Shared'));
    } catch (error) {
      // Dismissing the share sheet is not a failure: the picture stays open for another try.
      if (!(error instanceof DOMException && error.name === 'AbortError')) { download(data); close(); toast(t('Could not share here, so it was saved as a file')); }
    }
  }
  async function save(): Promise<void> { commitText(); const data = await blob(); if (data) { download(data); close(); toast(t('Saved')); } }

  // ---- the GIF ----------------------------------------------------------------------------------------------------------------------
  function startGif(): void {
    commitText();
    if (!sel || busy()) return;
    const area = { ...sel }, plan = planGif(area.w, area.h, seconds, window.devicePixelRatio || 1);
    try {
      recording = recordGif({
        area, seconds, plan, shapes: [...shapes], mark: withMark ? address : null,
        onProgress: p => {
          if (phase === 'starting' && !p.starting) { phase = 'recording'; syncBar(); }
          const share = p.total ? Math.min(1, p.elapsed / p.total) : 0;
          progressFill.style.transform = `scaleX(${share.toFixed(3)})`;
          progress.setAttribute('aria-valuenow', String(Math.round(share * 100)));
          const text = p.starting ? t('Starting…') : t('{done} of {total} s · {size}', { done: decimal.format(p.elapsed / 1000), total: seconds, size: mb(p.bytes) });
          if (progressText.textContent !== text) progressText.textContent = text;
        },
      });
    } catch (error) {
      console.warn('GIF:', error); toast(t('Could not record a GIF here')); return;
    }
    phase = 'starting'; stopAsked = false; progressFill.style.transform = 'scaleX(0)'; progressText.textContent = t('Starting…');
    syncBar(); redraw();
    const current = recording;
    void current.done.then(result => {
      if (closed || recording !== current) return;
      recording = null;
      // Stopped before the first frame there is nothing to keep, and nothing went wrong.
      if (!result) { phase = 'setup'; syncBar(); redraw(); if (!stopAsked) toast(t('Could not record a GIF here')); return; }
      showGif(result);
    });
  }
  function stopGif(): void {
    if (!recording || (phase !== 'starting' && phase !== 'recording')) return;
    phase = 'finishing'; stopAsked = true; progressText.textContent = t('Finishing…'); syncBar();
    recording.stop();
  }
  function showGif(result: GifResult): void {
    gif = result; phase = 'ready';
    if (gifUrl) URL.revokeObjectURL(gifUrl);
    gifUrl = URL.createObjectURL(result.blob);
    if (sel) { preview.style.left = `${sel.x}px`; preview.style.top = `${sel.y}px`; preview.style.width = `${sel.w}px`; preview.style.height = `${sel.h}px`; }
    preview.src = gifUrl; preview.hidden = false;
    resultText.textContent = t('{size} · {s} s · {fps} fps', { size: mb(result.bytes), s: decimal.format(result.duration / 1000), fps: result.fps });
    setTip(resultText, tn(result.frames, '{w} × {h} px, {n} frame', '{w} × {h} px, {n} frames', { w: result.width, h: result.height, n: result.frames }));
    syncBar(); redraw();
    // What was given up to keep the file under the limit, or why it is shorter than asked.
    const limit = GIF_LIMIT / 1e6, at = decimal.format(result.duration / 1000);
    if (result.ended === 'full') toast(t('Kept under {mb} MB: the GIF ends at {s} s', { mb: limit, s: at }));
    else if (result.fps < result.plannedFps) toast(t('Kept under {mb} MB: the frame rate went down to {fps} a second', { mb: limit, fps: result.fps }));
    else if (result.tolerance >= FAINT_TOLERANCE) toast(t('Kept under {mb} MB: the faintest changes were left out', { mb: limit }));
    else if (result.ended === 'hidden') toast(t('The page was hidden, so the GIF ends at {s} s', { s: at }));
  }
  function again(): void {
    gif = null; preview.hidden = true; preview.removeAttribute('src');
    if (gifUrl) { URL.revokeObjectURL(gifUrl); gifUrl = null; }
    phase = 'setup'; syncBar(); redraw();
  }
  function saveGif(): void { if (!gif) return; download(gif.blob, 'gif'); close(); toast(t('GIF saved')); }
  async function shareGif(): Promise<void> {
    if (!gif) return;
    const data = gif.blob;
    try {
      await navigator.share({ files: [new File([data], fileName(new Date(), timeZone() === 'utc', 'gif'), { type: 'image/gif' })], title: 'LiquidityMapperFast' });
      close(); toast(t('Shared'));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) { download(data, 'gif'); close(); toast(t('Could not share here, so it was saved as a file')); }
    }
  }
  async function copyGif(): Promise<void> {
    if (!gif) return;
    const data = gif.blob;
    if (!canCopyGif()) { download(data, 'gif'); close(); toast(t('This browser cannot copy a GIF, so it was saved as a file')); return; }
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/gif': data })]); close(); toast(t('GIF copied to the clipboard')); }
    catch { download(data, 'gif'); close(); toast(t('Could not copy here, so it was saved as a file')); }
  }

  function undo(): void { commitText(); const s = shapes.pop(); if (s) { redo.push(s); syncBar(); redraw(); } }
  function redoShape(): void { const s = redo.pop(); if (s) { shapes.push(s); syncBar(); redraw(); } }
  function close(): void {
    if (closed) return; closed = true; active = null;
    recording?.cancel(); recording = null;
    if (gifUrl) { URL.revokeObjectURL(gifUrl); gifUrl = null; }
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
      case 'line': case 'arrow': case 'block': d.b = shift ? snapAngle(d.a, q) : q; return;
      case 'text': return;
    }
  };
  stage.addEventListener('pointerdown', e => {
    // A GIF being recorded or made keeps its area: the stage takes no presses until it is set up again.
    if (e.button === 2 || busy()) return;
    const p = local(e);
    if (textBox && tool === 'text') commitText();
    if (sel && tool !== 'move') {
      if (!inside(sel, p)) return;
      if (tool === 'text') { startText(p); e.preventDefault(); return; }
      stage.setPointerCapture(e.pointerId); drag = { kind: 'draw' };
      const first = { ...p }; effectFrom = first;
      draft = tool === 'pen' || tool === 'marker' ? { kind: tool, points: [first], color, width }
        : tool === 'pixelate' || tool === 'blur' ? { kind: tool, rect: { x: p.x, y: p.y, w: 0, h: 0 }, strength }
        : tool === 'block' ? { kind: 'block', a: first, b: first, color, width, size: blockSize, fill: blockFill, border: blockBorder }
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
    if (busy()) return;
    const p = local(e); hover = p;
    if (!drag) {
      if (!sel) { hoverTarget = targetAt(p); hint.style.opacity = hoverTarget ? '0' : ''; }
      else if (tool === 'move') { const h = hitHandle(sel, p, handleReach); stage.style.cursor = h ? CURSORS[h] : inside(sel, p) ? 'move' : 'crosshair'; }
      redraw(); return;
    }
    if (drag.kind === 'new') { hint.hidden = true; redraw(); }
    else if (drag.kind === 'move' && sel) { sel = clampRect({ ...drag.start, x: drag.start.x + p.x - drag.from.x, y: drag.start.y + p.y - drag.from.y }, { w: W, h: H }); place(); redraw(); }
    else if (drag.kind === 'resize' && sel) { sel = resizeRect(sel, drag.handle, p, { w: W, h: H }); syncGif(); place(); redraw(); }
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
  stage.addEventListener('contextmenu', e => { e.preventDefault(); if (busy()) return; if (sel || shapes.length) { sel = null; shapes.length = 0; redo.length = 0; draft = null; textBox?.remove(); textBox = null; bar.hidden = true; hint.hidden = false; redraw(); } else close(); });

  // ---- keys -------------------------------------------------------------------------------------------------------------------------
  function onKey(e: KeyboardEvent): void {
    if (closed || (e.target instanceof HTMLInputElement && e.target.classList.contains('shot-text'))) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (mode === 'gif') {
      // Enter does the next thing a GIF needs: record, stop, then save (or share, on a phone).
      if (e.key === 'Enter' && sel) { e.preventDefault(); if (phase === 'setup') startGif(); else if (phase === 'starting' || phase === 'recording') stopGif(); else if (phase === 'ready') { if (shareGifButton) void shareGif(); else saveGif(); } return; }
      if (mod && k === 's') { e.preventDefault(); if (phase === 'ready') saveGif(); return; }
      if (mod && k === 'c') { e.preventDefault(); if (phase === 'ready') void copyGif(); return; }
      if (busy()) return;
    } else {
      if (e.key === 'Enter' && sel) { e.preventDefault(); void copy(); return; }
      if (mod && k === 'c' && sel) { e.preventDefault(); void copy(); return; }
      if (mod && k === 's' && sel) { e.preventDefault(); void save(); return; }
    }
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redoShape(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redoShape(); return; }
    if (!mod && !e.altKey && sel && k === 'g') { e.preventDefault(); chooseMode(mode === 'gif' ? 'picture' : 'gif'); return; }
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
