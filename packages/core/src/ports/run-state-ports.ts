import type { CardRow } from "../domain/card";
import type { SteeringRow } from "../domain/steering";

/** Owner messages sent while a run is busy. */
export interface SteeringPort {
  /** Store a row (held when it has no wake); a row whose id is already stored is left as it is. */
  add(r: SteeringRow): Promise<void>;
  /** Unclaimed rows bound to `wakeId`, oldest first, without claiming them. */
  bound(wakeId: string): Promise<SteeringRow[]>;
  /** Delete these rows. */
  remove(ids: string[]): Promise<void>;
  /** Unclaimed rows bound to `wakeId`, oldest first, marked claimed at `at` (one transaction). */
  claim(wakeId: string, at: number): Promise<SteeringRow[]>;
  /** Rows of the scope bound to no wake, oldest first. */
  held(scopeKey: string): Promise<SteeringRow[]>;
  /** Bind held, unclaimed rows to the wake that will deliver them; returns the ids actually bound. */
  bind(ids: string[], wakeId: string): Promise<string[]>;
  /** Drop the rows a finished turn claimed. */
  deleteClaimed(wakeId: string): Promise<void>;
  /** Unclaimed rows bound to `wakeId` become held again (the wake ended without taking them). */
  unbind(wakeId: string): Promise<void>;
  /** Give the claimed rows of a failed turn back (claimed -> unclaimed). */
  releaseClaimed(wakeId: string): Promise<void>;
  deleteForScope(scopeKey: string): Promise<void>;
  /**
   * Ids of ended runs (done, failed, interrupted, cancelled, blocked, dropped, expired) that still have
   * unclaimed or claimed rows bound to them, in id order, at most `limit`, after id `after`.
   */
  endedRuns(limit: number, after?: string): Promise<string[]>;
  /** Scope keys that have held rows (bound to no wake), in key order, at most `limit`, after key `after`. */
  heldScopes(limit: number, after?: string): Promise<string[]>;
}

/** Approval and question cards. */
export interface CardPort {
  /** Store a new card. */
  insert(c: CardRow): Promise<void>;
  /**
   * Store the cards of one ask (all of the same run) in one step, only when that run has no open card; false
   * (nothing stored) when it has one. Two concurrent asks of a run never both open cards.
   */
  insertIfNoneOpen(group: CardRow[]): Promise<boolean>;
  /** One card by id. */
  get(id: string): Promise<CardRow | undefined>;
  /** Open cards, oldest first. */
  open(): Promise<CardRow[]>;
  /** Open cards of one scope, oldest first. */
  openForScope(scopeKey: string): Promise<CardRow[]>;
  /** open -> answered, once; false when the card was not open. `messageId`: the owner message that answered it by text. */
  answer(id: string, answer: CardRow["answer"], at: number, messageId?: number): Promise<boolean>;
  /** Every card of run `wakeId` (any status), oldest first. */
  forWake(wakeId: string): Promise<CardRow[]>;
  /** Cards answered by the typed text of owner message `messageId`. */
  answeredByMessage(messageId: number): Promise<CardRow[]>;
  /** Guarded change `from` -> `to`; false when the card was not in `from`. */
  setStatus(id: string, from: CardRow["status"], to: CardRow["status"]): Promise<boolean>;
  /** Record that the owner was reminded of the card. */
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
  /** Store the result and mark the key done; only a started key changes, so the first result stays. */
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
  /** State of a scope; undefined when nothing was ever set. */
  get(key: string): Promise<ScopeState | undefined>;
  /** Set the scope effort. */
  setEffort(key: string, effort: string): Promise<void>;
  /** Ask for a fresh session next time. */
  markReset(key: string): Promise<void>;
  /** Clear the reset request. */
  clearReset(key: string): Promise<void>;
  /** Forget the scope effort (a fresh session starts at the bot's own effort). */
  clearEffort(key: string): Promise<void>;
  /**
   * Record the end of a run that started at `startedAt`. A scope never flushed counts as flushed at `startedAt`,
   * so its first idle flush covers only messages since that run began (not the whole history).
   */
  finished(key: string, at: number, startedAt: number): Promise<void>;
  /** Record a memory flush. */
  flushed(key: string, at: number): Promise<void>;
  /** Scopes finished before `before` and not flushed since they finished. */
  quiet(before: number): Promise<string[]>;
}
