import type { CardRow } from "../domain/card";
import type { SteeringRow } from "../domain/steering";

/** Owner messages sent while a run is busy. */
export interface SteeringPort {
  add(r: SteeringRow): Promise<void>;
  /** Unclaimed rows bound to `wakeId`, oldest first, marked claimed at `at` (one transaction). */
  claim(wakeId: string, at: number): Promise<SteeringRow[]>;
  /** Rows of the scope bound to no wake, oldest first. */
  held(scopeKey: string): Promise<SteeringRow[]>;
  /** Bind rows to the wake that will deliver them. */
  bind(ids: string[], wakeId: string): Promise<void>;
  /** Drop the rows a finished turn claimed. */
  deleteClaimed(wakeId: string): Promise<void>;
  /** Give the claimed rows of a failed turn back (claimed -> unclaimed). */
  releaseClaimed(wakeId: string): Promise<void>;
  deleteForScope(scopeKey: string): Promise<void>;
}

/** Approval and question cards. */
export interface CardPort {
  insert(c: CardRow): Promise<void>;
  get(id: string): Promise<CardRow | undefined>;
  /** Open cards, oldest first. */
  open(): Promise<CardRow[]>;
  /** Open cards of one scope, oldest first. */
  openForScope(scopeKey: string): Promise<CardRow[]>;
  /** open -> answered, once; false when the card was not open. */
  answer(id: string, answer: CardRow["answer"], at: number): Promise<boolean>;
  /** Guarded change `from` -> `to`; false when the card was not in `from`. */
  setStatus(id: string, from: CardRow["status"], to: CardRow["status"]): Promise<boolean>;
  markReminded(id: string, at: number): Promise<void>;
}

/** What `EffectPort.begin` found for a key. */
export type EffectBegin =
  | { state: "new" }
  | { state: "started" }
  | { state: "done"; result: string };

/** Records of side-effect calls, for replay safety. */
export interface EffectPort {
  /** Atomic: the first call for a key is "new"; later ones "started", or "done" with the result. */
  begin(key: string, wakeId: string, tool: string, at: number): Promise<EffectBegin>;
  /** Store the result and mark the key done. */
  finish(key: string, result: string, at: number): Promise<void>;
}

/** State of one scope (a bot session scope). */
export interface ScopeState {
  effort?: string;
  resetPending: boolean;
  lastFinishedAt?: number;
  lastFlushedAt?: number;
}

/** Per-scope state that outlives a run. */
export interface ScopePort {
  get(key: string): Promise<ScopeState | undefined>;
  setEffort(key: string, effort: string): Promise<void>;
  markReset(key: string): Promise<void>;
  clearReset(key: string): Promise<void>;
  finished(key: string, at: number): Promise<void>;
  flushed(key: string, at: number): Promise<void>;
  /** Scopes finished before `before` and not flushed since they finished. */
  quiet(before: number): Promise<string[]>;
}
