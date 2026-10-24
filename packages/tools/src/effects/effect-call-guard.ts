import type { EffectPort } from "@friday/core";
import { textResult } from "../tool-result";

/** What the guard needs to record effect calls (built per session by the app from the run's spec). */
export interface EffectRecorder {
  /** The replay records. */
  effects: EffectPort;
  /** Epoch milliseconds. */
  now(): number;
  /** The record key of one call (wake, approval card, tool, input hash and this execution's count). */
  keyOf(tool: string, input: Record<string, unknown>): Promise<string>;
  /** The wake of the run the call belongs to. */
  wakeId: string;
}

/** The shape every tool handler returns. */
type ToolResult = ReturnType<typeof textResult>;

/** Said when a record exists but holds no result: the call may have run before a restart. */
export const EFFECT_REPLAY_WARNING =
  "this call may already have run before the restart; check the state before repeating it";

/**
 * Run an effect so a run executed again after a cut does not repeat it. `new`: run it and store the text of a
 * successful result. `done`: return the stored result without running. `started`: return the replay warning
 * (the earlier call began and has no result, so its effect may be half done). A call that fails or throws is
 * not finished, so a re-execution gets the warning: the safe answer for a half-done effect. Without a recorder
 * (no stored run) the effect just runs.
 */
export async function withEffectRecord(
  rec: EffectRecorder | undefined,
  tool: string,
  input: Record<string, unknown>,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  if (!rec) return run();
  const key = await rec.keyOf(tool, input);
  const begin = await rec.effects.begin(key, rec.wakeId, tool, rec.now());
  if (begin.state === "done") return textResult(begin.result);
  if (begin.state === "started") return textResult(EFFECT_REPLAY_WARNING, true);
  const result = await run();
  if (!result.isError) await rec.effects.finish(key, result.content[0]?.text ?? "", rec.now());
  return result;
}
