import type { Log } from "../ports/log";
import type { Memory, MemoryOwner } from "../ports/memory";

/**
 * The owner's on rules as a prompt text; "" when none is on, when the adapter has no rules, or when the read
 * fails (a failed read is logged and never fails a run's open).
 */
export async function readRulesText(
  memory: Memory | undefined,
  owner: MemoryOwner,
  log?: Log,
): Promise<string> {
  if (!memory?.readRules) return "";
  try {
    return await memory.readRules(owner);
  } catch (err) {
    log?.warn(
      { owner, err: err instanceof Error ? err.message : String(err) },
      "rules.read_failed",
    );
    return "";
  }
}
