import type { EngineBootstrap, EngineTick, FootprintAnswer, VenueStatus } from '../../shared/engine.ts';
import type { Candle, OiBar } from '../../shared/series.ts';
import type { Print } from '../../shared/prints.ts';
import type { FlowFrame, FlowUpdate } from '../../shared/flow.ts';
import type { ColumnsFrame } from '../../shared/columns.ts';
import type { LevelsFrame } from '../wire.ts';

/** What the page asks the feeds worker for; each has an answer of the type in `RpcResult`. */
export type RpcCall =
  | { method: 'bootstrap' }
  | { method: 'columns'; ids: string[]; from: number; to: number; stepMs: number }
  | { method: 'footprint'; inst: string; tfMs: number; from: number; to: number; rowStep: number }
  | { method: 'prints'; from: number; to: number }
  | { method: 'flow'; ids: string[]; from: number; to: number }
  | { method: 'candles'; inst: string; tfMs: number; from: number; to: number }
  | { method: 'oi'; inst: string; tfMs: number; from: number; to: number };

export interface RpcResult {
  bootstrap: EngineBootstrap; columns: ColumnsFrame; footprint: FootprintAnswer; prints: Print[]; flow: FlowFrame; candles: Candle[]; oi: OiBar[];
}

export type FeedsIn =
  /** Start the engine with these venues (null: the recommended set); `persist` keeps recordings in this browser (IndexedDB). */
  | { type: 'init'; selected: string[] | null; persist: boolean }
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
  | { type: 'status'; venues: VenueStatus[] }
  /** Whether this tab is the one writing recordings (another tab may hold that role); `failed`: its storage stopped working, so it will not be. */
  | { type: 'recording'; recording: boolean; failed?: boolean }
  | { type: 'rpc'; id: number; result?: unknown; error?: string };
