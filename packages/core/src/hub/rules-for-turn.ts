import type { Conversation } from "../domain/conversation";
import type { Log } from "../ports/log";
import type { Memory, MemoryOwner } from "../ports/memory";
import { NO_RULES_NOTE } from "./rules-label";
import type { PoolEntry } from "./session-pool";

/**
 * The owner's on rules as a prompt text; "" when none is on, when the adapter has no rules, or when the read
 * fails (a failed read is logged and never fails a turn or an open).
 */
export async function readRulesText(
  memory: Memory | undefined,
  owner: MemoryOwner,
  log?: Log,
): Promise<string> {
  return (await tryReadRules(memory, owner, log)) ?? "";
}

/** The owner's on rules; undefined when the adapter has none or the read failed (logged). */
async function tryReadRules(
  memory: Memory | undefined,
  owner: MemoryOwner,
  log?: Log,
): Promise<string | undefined> {
  if (!memory?.readRules) return undefined;
  try {
    return await memory.readRules(owner);
  } catch (err) {
    log?.warn(
      { owner, err: err instanceof Error ? err.message : String(err) },
      "rules.read_failed",
    );
    return undefined;
  }
}

/**
 * The rules a turn must carry: the bot's own when they differ from what the session last saw, and, on a group
 * turn, the group's the same way (a compaction clears the group's, so they come again). A list whose rules are
 * all off now gives "(none)" so a running session drops the old ones. A failed read sends nothing and keeps
 * what was shown.
 */
export async function rulesForTurn(
  entry: PoolEntry,
  conv: Conversation | undefined,
  memory: Memory | undefined,
  log?: Log,
): Promise<{ botRules?: string; groupRules?: string }> {
  const out: { botRules?: string; groupRules?: string } = {};
  if (!memory?.readRules) return out;
  const read = (owner: MemoryOwner) => tryReadRules(memory, owner, log);
  const bot = await read({ kind: "bot", botId: entry.bot.id });
  if (bot !== undefined && bot !== entry.rulesShown) {
    entry.rulesShown = bot;
    out.botRules = bot || NO_RULES_NOTE;
  }
  if (conv?.kind === "group") {
    const group = await read({ kind: "group", groupId: conv.groupId });
    if (group !== undefined && group !== (entry.groupRulesSent.get(conv.groupId) ?? "")) {
      entry.groupRulesSent.set(conv.groupId, group);
      out.groupRules = group || NO_RULES_NOTE;
    }
  }
  return out;
}
