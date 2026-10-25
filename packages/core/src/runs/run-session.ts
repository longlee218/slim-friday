import type { CoreLimits } from "../config-defaults";
import { groupContextFor } from "../hub/group-context";
import { groupMemoryFor, promptMemory } from "../hub/group-memory";
import { errText } from "../hub/hub-types";
import { readRulesText } from "../hub/rules-text";
import type { SessionScope } from "../hub/session-scope";
import type { AgentRuntime, BotRuntimeSpec, BotSession } from "../ports/agent-runtime";
import type { Log } from "../ports/log";
import { GROUP_SESSION_KINDS, type Memory } from "../ports/memory";
import type { Store } from "../ports/store";
import type { ProjectRulesReader } from "../routing/group-context";
import { SetupError } from "./run-rules";

/** What opening a run's session needs. */
export interface RunSessionDeps {
  runtime: AgentRuntime;
  store: Store;
  memory?: Memory;
  limits: CoreLimits;
  log?: Log;
  /** Reads a group's project rules for its group context. */
  projectRules?: ProjectRulesReader;
}

/** An open session and the memory its system prompt got (bot and group memory; "" when none). */
export interface OpenedRunSession {
  session: BotSession;
  memory: string;
}

/**
 * Open the scope's session for one run. What goes into the system prompt is read fresh: the owner's rules for
 * the bot, the bot memory (a group scope gets only the bot's preferences and lessons) and, for a group scope, the
 * group context, the group's rules and the group memory. The stored session id is resumed, else a new session opens; a stored id that will
 * not resume is cleared. A scope marked `resetPending` gets a fresh session, unless it has an open card or the run resumes a card's answer (a parked
 * approval keeps its own session until it is resolved and resumed); the mark and the stored effort are cleared then. A session that will not open
 * (workspace, MCP server, runtime start) throws `SetupError`, so the run is retried as a setup failure.
 */
export async function openRunSession(
  d: RunSessionDeps,
  scope: SessionScope,
  spec: Omit<BotRuntimeSpec, "memory">,
  /** The run resumes a card's answer: it keeps its own session, so a pending reset waits for a later open. */
  resumesCard = false,
): Promise<OpenedRunSession> {
  const { store } = d;
  // A memory that cannot be read must not keep the bot from answering.
  const memory = await promptMemory(
    d.memory,
    { kind: "bot", botId: scope.bot.id },
    d.limits.memoryPromptChars,
    d.log,
    // A group session gets only the bot's rules and lessons: its facts may come from the owner's direct chat.
    scope.groupId ? GROUP_SESSION_KINDS : undefined,
  );
  // The owner's rules are whole (never cut by the memory cap) and read at every open, so an edit reaches the next run.
  const rules = await readRulesText(d.memory, { kind: "bot", botId: scope.bot.id }, d.log);
  const groupRules = scope.groupId
    ? await readRulesText(d.memory, { kind: "group", groupId: scope.groupId }, d.log)
    : "";
  const group = scope.groupId ? await store.groups.get(scope.groupId) : undefined;
  const groupContext = group ? await groupContextFor(group, d.projectRules) : undefined;
  const groupMemory = scope.groupId
    ? await groupMemoryFor(scope.groupId, d.memory, d.limits.groupMemoryPromptChars, d.log)
    : undefined;
  const state = await store.scopes.get(scope.key);
  const fresh =
    state?.resetPending === true &&
    !resumesCard &&
    (await store.cards.openForScope(scope.key)).length === 0;
  const full: BotRuntimeSpec = {
    ...spec,
    // A fresh session starts at the bot's own effort, not the old session's SetEffort level.
    ...(fresh && { bot: scope.bot }),
    ...(rules && { rules }),
    ...(memory.trim() && { memory }),
    ...(groupContext && { groupContext }),
    ...(groupRules && { groupRules }),
    ...(groupMemory && { groupMemory }),
  };
  const stored = fresh ? undefined : await store.sessions.get(scope.key);
  let session: BotSession | undefined;
  try {
    if (stored) {
      try {
        session = await d.runtime.resume(stored, full);
      } catch {
        // The stored session is gone or unreadable: forget it and start a fresh one.
        await store.sessions.clear(scope.key);
      }
    }
    session ??= await d.runtime.open(full);
  } catch (err) {
    throw new SetupError(errText(err), { cause: err });
  }
  await store.sessions.set(scope.key, session.id);
  if (fresh) {
    await store.scopes.clearReset(scope.key);
    await store.scopes.clearEffort(scope.key);
  }
  return { session, memory: `${memory}\n${groupMemory ?? ""}` };
}
