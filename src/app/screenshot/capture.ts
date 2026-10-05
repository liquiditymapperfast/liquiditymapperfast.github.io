/**
 * A picture of the page, drawn by walking it: every canvas is copied at its place, and the boxes, borders and text of the ordinary
 * elements are painted around them. This needs no permission prompt (unlike capturing the screen), cannot taint the canvas (unlike
 * serialising the page into an image) and is exact where it matters, because the chart, the order book and the panes are canvases. The
 * toolbar and pane headers are approximated from their computed styles: boxes, borders, rounded corners, text, gradients, selects and
 * sliders; shadows and pseudo-elements are left out.
 */
export interface Snapshot { canvas: HTMLCanvasElement; /** Canvas pixels per CSS pixel. */ scale: number; width: number; height: number }

const num = (value: string): number => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; };

/** Split on commas that are not inside parentheses. */
export function splitTop(text: string): string[] {
  const parts: string[] = []; let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth === 0) { parts.push(text.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(text.slice(from).trim());
  return parts.filter(Boolean);
}

/** The first `linear-gradient(...)` of a computed `background-image`, as a canvas gradient over `box`, or null. */
export function gradientFor(ctx: CanvasRenderingContext2D, image: string, box: { x: number; y: number; w: number; h: number }): CanvasGradient | null {
  const start = image.indexOf('linear-gradient('); if (start < 0) return null;
  let depth = 0, end = -1;
  for (let i = start + 'linear-gradient'.length; i < image.length; i++) { if (image[i] === '(') depth++; else if (image[i] === ')' && --depth === 0) { end = i; break; } }
  if (end < 0) return null;
  const args = splitTop(image.slice(start + 'linear-gradient('.length, end));
  let angle = 180; // CSS default: to bottom
  const first = args[0] ?? '';
  if (/^to /.test(first)) { const dir = first.slice(3).trim(); angle = dir === 'right' ? 90 : dir === 'left' ? 270 : dir === 'top' ? 0 : 180; args.shift(); }
  else if (/deg$/.test(first)) { angle = num(first); args.shift(); }
  const rad = angle * Math.PI / 180, half = (Math.abs(box.w * Math.sin(rad)) + Math.abs(box.h * Math.cos(rad))) / 2;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, dx = Math.sin(rad) * half, dy = -Math.cos(rad) * half;
  const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  args.forEach((stop, i) => {
    const m = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(stop); if (!m) return;
    const at = m[2] !== undefined ? Math.max(0, Math.min(1, num(m[2]) / 100)) : (args.length > 1 ? i / (args.length - 1) : 0);
    try { gradient.addColorStop(at, m[1]!.trim()); } catch { /* an unparsable colour is skipped */ }
  });
  return gradient;
}

function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radii: number[]): void {
  ctx.beginPath();
  if (radii.some(r => r > 0) && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, radii.map(r => Math.min(r, w / 2, h / 2))); else ctx.rect(x, y, w, h);
}

function paintBox(ctx: CanvasRenderingContext2D, rect: DOMRect, cs: CSSStyleDeclaration): void {
  const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(num);
  const box = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') { roundedPath(ctx, box.x, box.y, box.w, box.h, radii); ctx.fillStyle = cs.backgroundColor; ctx.fill(); }
  if (cs.backgroundImage && cs.backgroundImage !== 'none') {
    const gradient = gradientFor(ctx, cs.backgroundImage, box);
    if (gradient) { roundedPath(ctx, box.x, box.y, box.w, box.h, radii); ctx.fillStyle = gradient; ctx.fill(); }
  }
  const widths = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(num);
  const styles = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
  const colors = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
  const drawn = widths.map((w, i) => w > 0 && styles[i] !== 'none' && styles[i] !== 'hidden');
  if (drawn.every(Boolean) && widths.every(w => w === widths[0]) && colors.every(c => c === colors[0])) {
    const w = widths[0]!; roundedPath(ctx, box.x + w / 2, box.y + w / 2, box.w - w, box.h - w, radii.map(r => Math.max(0, r - w / 2)));
    ctx.strokeStyle = colors[0]!; ctx.lineWidth = w; ctx.setLineDash(styles[0] === 'dashed' ? [4, 3] : styles[0] === 'dotted' ? [1, 2] : []); ctx.stroke(); ctx.setLineDash([]);
  } else {
    const side = (i: number, x1: number, y1: number, x2: number, y2: number): void => { if (!drawn[i]) return; ctx.strokeStyle = colors[i]!; ctx.lineWidth = widths[i]!; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    side(0, box.x, box.y + widths[0]! / 2, box.x + box.w, box.y + widths[0]! / 2);
    side(1, box.x + box.w - widths[1]! / 2, box.y, box.x + box.w - widths[1]! / 2, box.y + box.h);
    side(2, box.x, box.y + box.h - widths[2]! / 2, box.x + box.w, box.y + box.h - widths[2]! / 2);
    side(3, box.x + widths[3]! / 2, box.y, box.x + widths[3]! / 2, box.y + box.h);
  }
}

const fontOf = (cs: CSSStyleDeclaration): string => `${cs.fontStyle === 'normal' ? '' : `${cs.fontStyle} `}${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

function paintText(ctx: CanvasRenderingContext2D, node: Text, cs: CSSStyleDeclaration): void {
  const data = node.data; if (!data.trim()) return;
  ctx.font = fontOf(cs); ctx.fillStyle = cs.color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const transform = cs.textTransform, range = document.createRange();
  for (const match of data.matchAll(/\S+/g)) {
    range.setStart(node, match.index!); range.setEnd(node, match.index! + match[0].length);
    const rect = range.getBoundingClientRect(); if (rect.width === 0 && rect.height === 0) continue;
    let word = match[0]; if (transform === 'uppercase') word = word.toUpperCase(); else if (transform === 'lowercase') word = word.toLowerCase();
    ctx.fillText(word, rect.left, rect.top + rect.height / 2 + 0.5);
  }
}

function paintControl(ctx: CanvasRenderingContext2D, node: Element, rect: DOMRect, cs: CSSStyleDeclaration): void {
  const pad = num(cs.paddingLeft) + num(cs.borderLeftWidth);
  ctx.font = fontOf(cs); ctx.fillStyle = cs.color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  if (node instanceof HTMLSelectElement) {
    ctx.fillText(node.selectedOptions[0]?.text ?? '', rect.left + pad, rect.top + rect.height / 2 + 0.5, Math.max(0, rect.width - pad - 22));
    ctx.strokeStyle = cs.color; ctx.lineWidth = 1.3; ctx.beginPath();
    ctx.moveTo(rect.right - 14, rect.top + rect.height / 2 - 2); ctx.lineTo(rect.right - 10.5, rect.top + rect.height / 2 + 1.5); ctx.lineTo(rect.right - 7, rect.top + rect.height / 2 - 2); ctx.stroke();
  } else if (node instanceof HTMLInputElement) {
    if (node.type === 'range') {
      const min = num(node.min || '0'), max = num(node.max || '100'), at = max > min ? (num(node.value) - min) / (max - min) : 0;
      const y = rect.top + rect.height / 2, x0 = rect.left + 6, x1 = rect.right - 6;
      ctx.strokeStyle = 'rgba(128,128,128,.55)'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillStyle = cs.accentColor && cs.accentColor !== 'auto' ? cs.accentColor : cs.color; ctx.beginPath(); ctx.arc(x0 + (x1 - x0) * at, y, 5.5, 0, Math.PI * 2); ctx.fill();
    } else if (node.type === 'checkbox') {
      ctx.strokeStyle = cs.color; ctx.lineWidth = 1.2; ctx.strokeRect(rect.left + 1.5, rect.top + 1.5, rect.width - 3, rect.height - 3);
      if (node.checked) { ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(rect.left + 3.5, rect.top + rect.height / 2); ctx.lineTo(rect.left + rect.width * 0.42, rect.bottom - 4); ctx.lineTo(rect.right - 3.5, rect.top + 4); ctx.stroke(); }
    } else if (node.value) ctx.fillText(node.value, rect.left + pad, rect.top + rect.height / 2 + 0.5, Math.max(0, rect.width - 2 * pad));
  }
}

function paintNode(ctx: CanvasRenderingContext2D, node: Element, view: { w: number; h: number }): void {
  const cs = getComputedStyle(node);
  if (cs.display === 'none' || cs.visibility === 'hidden' || node.hasAttribute('data-no-capture')) return;
  const opacity = num(cs.opacity); if (opacity <= 0) return;
  const rect = node.getBoundingClientRect();
  const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
  // Nothing of a clipping box that is wholly off screen can show, and neither can any of its children.
  if (clips && (rect.right < 0 || rect.bottom < 0 || rect.left > view.w || rect.top > view.h)) return;
  ctx.save();
  ctx.globalAlpha *= opacity;
  if (rect.width > 0 && rect.height > 0) {
    paintBox(ctx, rect, cs);
    if (node instanceof HTMLCanvasElement) { if (node.width > 0 && node.height > 0) { try { ctx.drawImage(node, rect.left, rect.top, rect.width, rect.height); } catch { /* a tainted or lost canvas is skipped */ } } }
    else if (node instanceof HTMLSelectElement || node instanceof HTMLInputElement) paintControl(ctx, node, rect, cs);
    if (clips) { ctx.beginPath(); ctx.rect(rect.left, rect.top, rect.width, rect.height); ctx.clip(); }
  }
  if (!(node instanceof HTMLSelectElement) && !(node instanceof HTMLInputElement) && !(node instanceof HTMLCanvasElement)) {
    const children = [...node.childNodes];
    const zOf = (child: Node): number => { if (!(child instanceof Element)) return 0; const c = getComputedStyle(child); return c.position !== 'static' && c.zIndex !== 'auto' ? num(c.zIndex) : 0; };
    // Positioned children with a z-index paint above their siblings, as in the page (the pulse layer sits above the chart's overlay).
    const ordered = children.map((child, i) => ({ child, i, z: zOf(child) })).sort((a, b) => a.z - b.z || a.i - b.i);
    for (const { child } of ordered) {
      if (child instanceof Element) paintNode(ctx, child, view);
      else if (child instanceof Text) paintText(ctx, child, cs);
    }
  }
  ctx.restore();
}

/** Draw the page as it is on screen now. Open panels and dialogs are included; tooltips are not (they are hidden by the click that started this). */
export function capturePage(root: HTMLElement = document.body): Snapshot {
  const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
  const scale = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  for (const child of root.children) if (!child.classList.contains('shot-stage') && !child.classList.contains('tip')) paintNode(ctx, child, { w: width, h: height });
  return { canvas, scale, width, height };
}
