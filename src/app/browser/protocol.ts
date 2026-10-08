import type { EngineBootstrap, EngineTick, FootprintAnswer, VenueStatus } from '../../shared/engine.ts';
import type { Candle, OiBar } from '../../shared/series.ts';
import type { Print } from '../../shared/prints.ts';
import type { ProfileAnswer, RangeAnswer, SizesAnswer, ValueAreaAnswer } from '../../shared/footprint.ts';
import type { AbsorptionAnswer, AbsorptionGroup, AbsorptionMinute } from '../../shared/absorption.ts';
import type { FlowFrame, FlowUpdate } from '../../shared/flow.ts';
import type { ColumnsFrame } from '../../shared/columns.ts';
import type { LevelsFrame } from '../wire.ts';
import type { Coin } from '../../shared/coins.ts';

/** What the page asks the feeds worker for; each has an answer of the type in `RpcResult`. */
export type RpcCall =
  | { method: 'bootstrap' }
  | { method: 'columns'; ids: string[]; from: number; to: number; stepMs: number }
  | { method: 'footprint'; inst: string; tfMs: number; from: number; to: number; rowStep: number }
  | { method: 'prints'; from: number; to: number; minUsd?: number }
  | { method: 'flow'; ids: string[]; from: number; to: number }
  | { method: 'sizes'; ids: string[]; windows: number[] }
  | { method: 'profile'; ids: string[]; from: number; to: number; rowStep: number }
  | { method: 'range'; ids: string[]; from: number; to: number; band: { p0: number; p1: number } | null; rowStep: number }
  | { method: 'valueAreas'; ids: string[]; windows: { from: number; to: number }[]; rowStep: number; share: number }
  | { method: 'absorption'; ids: string[]; mins: number[]; from: number; to: number; limit: number; since: number }
  | { method: 'candles'; inst: string; tfMs: number; from: number; to: number }
  | { method: 'oi'; inst: string; tfMs: number; from: number; to: number };

export interface RpcResult {
  bootstrap: EngineBootstrap; columns: ColumnsFrame; footprint: FootprintAnswer; prints: Print[]; flow: FlowFrame; sizes: SizesAnswer; profile: ProfileAnswer; range: RangeAnswer; valueAreas: ValueAreaAnswer; absorption: AbsorptionAnswer; candles: Candle[]; oi: OiBar[];
}

export type FeedsIn =
  /**
   * Start the engine on this coin with these venues (null: the recommended set); `persist` keeps recordings in this browser (IndexedDB),
   * in `database`, with `lock` held by the one tab that writes them.
   */
  | { type: 'init'; selected: string[] | null; known: string[] | null; persist: boolean; coin: Coin; tier: number; database: string; lock: string }
  | { type: 'select'; selected: string[] }
  /** The page is going away: write what has not been saved. */
  | { type: 'flush' }
  | ({ type: 'rpc'; id: number } & RpcCall);

export type FeedsOut =
  | { type: 'ready'; persisted: boolean }
  /** The engine could not be started: nothing will be answered, so the page should say so instead of waiting. */
  | { type: 'failed'; error: string }
  | { type: 'levels'; frame: LevelsFrame }
  | { type: 'tick'; tick: EngineTick }
  | { type: 'prints'; items: Print[] }
  | { type: 'flow'; items: FlowUpdate[] }
  | { type: 'absorption'; groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] }
  | { type: 'status'; venues: VenueStatus[] }
  /** Whether this tab is the one writing recordings (another tab may hold that role); `failed`: its storage stopped working, so it will not be. */
  | { type: 'recording'; recording: boolean; failed?: boolean }
  | { type: 'rpc'; id: number; result?: unknown; error?: string };
