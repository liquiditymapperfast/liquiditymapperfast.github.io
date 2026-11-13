import test from 'node:test';
import assert from 'node:assert/strict';
import { TrailGL, type TrailFrame } from '../src/app/candle/trail-gl.ts';
import { TapeRing } from '../src/app/tape/ring.ts';
import { packTape } from '../src/shared/tape.ts';

/**
 * A stand-in WebGL2 context that accepts every call and logs, per framebuffer bound (`screen` for the canvas's own), the clears, the
 * invalidations and the draws: enough to check the order a tiled card (a phone's) is told what it need not load.
 */
function recordingGl(): { gl: WebGL2RenderingContext; log: string[] } {
  const consts = new Map<string, number>(), log: string[] = [];
  const constant = (name: string): number => { if (!consts.has(name)) consts.set(name, consts.size + 1); return consts.get(name)!; };
  let fbos = 0, bound = 'screen';
  const calls: Record<string, (...a: unknown[]) => unknown> = {
    getExtension: () => ({}), getShaderParameter: () => true, getProgramParameter: () => true, getUniformLocation: (_p, name) => name,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'), isContextLost: () => false,
    createFramebuffer: () => ({ fbo: ++fbos }),
    bindFramebuffer: (_target, fb) => { bound = fb ? `fbo${(fb as { fbo: number }).fbo}` : 'screen'; log.push(`bind ${bound}`); },
    clear: () => { log.push(`clear ${bound}`); }, invalidateFramebuffer: () => { log.push(`invalidate ${bound}`); },
    drawArrays: () => { log.push(`draw ${bound}`); },
  };
  const gl = new Proxy({}, { get: (_t, name) => typeof name !== 'string' ? undefined : /^[A-Z0-9_]+$/.test(name) ? constant(name) : calls[name] ?? (() => ({})) }) as unknown as WebGL2RenderingContext;
  return { gl, log };
}

const T0 = 1_800_000_000_000;

function frame(glass: boolean, now: number): TrailFrame {
  return {
    style: 'phosphor', dark: true, bid: [0, 1, 0], ask: [1, 0, 0], mid: [1, 1, 1], now, windowMs: 60_000, x0: 0, x1: 300, y0: 8, y1: 580, p0: 79_900, p1: 80_100,
    floorUsd: 100, ceilUsd: 250_000, opacity: 0.8, flashes: [],
    glass: glass ? {
      y0: 8, y1: 580, frost: [], bricks: false, pulse: 'pressure', nowMs: 0, fill: 0.18, bookBid: [0, 1, 0], bookAsk: [1, 0, 0],
      pieces: [{ x0: 2, x1: 100, candle: false }, { x0: 104, x1: 204, candle: true }, { x0: 208, x1: 300, candle: false }],
    } : null,
  };
}

function trail(): { renderer: TrailGL; log: string[]; attributes: () => WebGLContextAttributes | undefined } {
  const { gl, log } = recordingGl();
  let asked: WebGLContextAttributes | undefined;
  const canvas = { width: 300, height: 600, style: {}, getContext: (_type: string, attributes?: WebGLContextAttributes) => { asked = attributes; return gl; } } as unknown as HTMLCanvasElement;
  const ring = new TapeRing(4096);
  ring.add(packTape(Array.from({ length: 50 }, (_, i) => ({ instrumentId: 'binance:BTCUSDT', tradeId: `t${i}`, side: i % 2 ? 'sell' as const : 'buy' as const, t: T0 + i * 100, price: 80_000 + i, lo: 80_000 + i, hi: 80_000 + i, usd: 5_000 + i, fills: 1 })), 1), 1, 0, T0);
  const renderer = new TrailGL(canvas, ring);
  renderer.resize(300, 600, 1);
  return { renderer, log, attributes: () => asked };
}

/** The log cut into what was done on each framebuffer between binds. */
const passes = (log: readonly string[]): { fb: string; ops: string[] }[] => {
  const out: { fb: string; ops: string[] }[] = [{ fb: 'screen', ops: [] }];
  for (const line of log) { const [op, fb] = line.split(' ') as [string, string]; if (op === 'bind') out.push({ fb, ops: [] }); else out[out.length - 1]!.ops.push(op); }
  return out.filter(p => p.ops.length);
};

test('with glass the screen is cleared once, just before the composite draws all of it, and every pass starts from a clear or an invalidation', () => {
  const { renderer, log } = trail();
  renderer.wave(150, 300, 200_000, 25_000, 0);
  log.length = 0;
  renderer.draw(frame(true, T0 + 5_000));
  const screen = log.filter(l => l.endsWith(' screen') && !l.startsWith('bind'));
  assert.deepEqual(screen, ['clear screen', 'draw screen'], 'the screen is not cleared at the start of a frame it will write over whole');
  assert.ok(!log.includes('invalidate screen'), 'the canvas\'s own framebuffer is never invalidated (its colour attachment is not COLOR_ATTACHMENT0)');
  const drawn = passes(log).filter(p => p.ops.includes('draw'));
  assert.ok(drawn.length >= 6, `the waves' substeps, the trail, the small copy, the blur's two halves and the composite (${drawn.length} passes)`);
  for (const p of drawn) assert.ok(p.ops[0] === 'clear' || p.ops[0] === 'invalidate', `a pass on ${p.fb} begins ${p.ops.join(',')}`);
});

test('the trail asks its canvas for no depth buffer (nothing it draws tests depth)', () => {
  const { attributes } = trail();
  assert.equal(attributes()?.depth, false);
  assert.equal(attributes()?.premultipliedAlpha, true);
});

test('without glass the trail is drawn straight onto the screen, cleared first', () => {
  const { renderer, log } = trail();
  log.length = 0;
  renderer.draw(frame(false, T0 + 5_000));
  const screen = log.filter(l => l.endsWith(' screen') && !l.startsWith('bind'));
  assert.equal(screen[0], 'clear screen');
  assert.ok(screen.slice(1).every(l => l === 'draw screen') && screen.length > 1, screen.join(','));
});
