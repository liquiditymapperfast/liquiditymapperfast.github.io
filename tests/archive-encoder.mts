/**
 * A tile writer for the tests, from the wire format v1 (docs/proposals/long-history-tiles-2026-11-05.md): what hlm-history writes, so the
 * page's reader is checked against the contract rather than against itself.
 */
import { LT_LENGTH } from '../src/shared/lt-sample.ts';
import { TILE_HEADER_BYTES, levelOfUsd } from '../src/app/archive/tiles.ts';

export interface EncColumn { index: number; n: number; step: number; bins: number[]; bid: number[]; ask: number[]; ltN?: number; lt?: number[]; open?: boolean; cut?: boolean }
export interface EncFile { level: number; packStart: number; windows: number; head?: boolean; through: number; books: [string, EncColumn[]][] }

export function encodeTile(f: EncFile): ArrayBuffer {
  const parts: number[] = [];
  const out = new DataView(new ArrayBuffer(1 << 22));
  let at = 0;
  const u8 = (v: number): void => { out.setUint8(at, v); at += 1; };
  const u16 = (v: number): void => { out.setUint16(at, v, true); at += 2; };
  const u32 = (v: number): void => { out.setUint32(at, v, true); at += 4; };
  const i32 = (v: number): void => { out.setInt32(at, v, true); at += 4; };
  const i64 = (v: number): void => { out.setBigInt64(at, BigInt(v), true); at += 8; };
  const f32 = (v: number): void => { out.setFloat32(at, v, true); at += 4; };
  const f64 = (v: number): void => { out.setFloat64(at, v, true); at += 8; };
  for (const c of 'HLMT') u8(c.charCodeAt(0));
  u16(1); u16(f.level); i64(f.packStart); u16(f.windows); u16(f.head ? 1 : 0); i64(f.through); u16(f.books.length);
  if (at !== TILE_HEADER_BYTES) throw new Error(`header is ${at} bytes`);
  const text = new TextEncoder();
  for (const [id, columns] of f.books) {
    const name = text.encode(id);
    u8(name.length); for (const b of name) u8(b);
    u16(columns.length);
    for (const c of columns) {
      u16(c.index); u8((c.open ? 1 : 0) | (c.cut ? 2 : 0)); u32(c.n); f64(c.step); u32(c.bins.length);
      c.bins.forEach((b, i) => i32(i ? b - c.bins[i - 1]! : b));
      for (const v of c.bid) u16(levelOfUsd(v));
      for (const v of c.ask) u16(levelOfUsd(v));
      u32(c.ltN ?? 0);
      if ((c.ltN ?? 0) > 0) { const lt = c.lt ?? new Array(LT_LENGTH).fill(0); for (let i = 0; i < LT_LENGTH; i++) f32(lt[i]!); }
    }
  }
  void parts;
  return out.buffer.slice(0, at);
}
