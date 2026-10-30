import type { CoreLimits } from "../config-defaults";
import { computerContextBlock } from "../hub/computer-context-block";
import { groupContextFor } from "../hub/group-context";
import { groupMemoryFor, promptMemory } from "../hub/group-memory";
import { errText } from "../hub/hub-types";
import { readRulesText } from "../hub/rules-text";
import { scratchpadBlock } from "../hub/scratchpad-block";
import type { SessionScope } from "../hub/session-scope";
import { teammateDirectory } from "../hub/teammate-directory";
import type { AgentRuntime, BotRuntimeSpec, BotSession } from "../ports/agent-runtime";
import type { Log } from "../ports/log";
import { GROUP_SESSION_KINDS, type Memory } from "../ports/memory";
import type { Store } from "../ports/store";
import type { ProjectRulesReader } from "../routing/group-context";
import { SetupError } from "./run-rules";
import {
  nextStateHashes,
  type StatePart,
  stateChangedBlock,
  stateHashes,
  stateParts,
} from "./session-state";

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
  /**
   * The `<state_changed>` block for a resumed session whose memory, rules, group context, teammates or scratchpad
   * changed since it last saw them (its system prompt is the one it started with); unset when nothing changed.
   */
  stateChanged?: string;
  /**
   * Store the state hashes this session now has (and log `session.state_changed`); later calls do nothing. Call
   * it only once the session took the turn (with `stateChanged`), i.e. at its first model event: a run cut before
   * that resumes later and gets the block again.
   */
  commitState: () => Promise<void>;
}

/**
 * Open the scope's session for one run. What goes into the system prompt is read fresh: the owner's rules for
 * the bot, the bot memory (a group scope gets only the bot's preferences and lessons) and, for a group scope, the
 * group context, the group's rules and the group memory; a direct scope also gets the teammate directory. The stored session id is resumed, else a new session opens; a stored id that will
 * not resume is cleared. A scope marked `resetPending` gets a fresh session, unless it has an open card or the run resumes a card's answer (a parked
 * approval keeps its own session until it is resolved and resumed); the mark and the stored effort are cleared then. A session that will not open
 * (workspace, MCP server, runtime start) throws `SetupError`, so the run is retried as a setup failure.
 * The hashes of the state parts are stored per session (by `commitState`, once the turn was taken): a resumed
 * session gets the changed parts as a `<state_changed>` block; a part whose read failed is neither reported nor
 * re-hashed.
 */
export async function openRunSession(
  d: RunSessionDeps,
  scope: SessionScope,
  spec: Omit<BotRuntimeSpec, "memory" | "teammates" | "scratchpad">,
  /** The run resumes a card's answer: it keeps its own session, so a pending reset waits for a later open. */
  resumesCard = false,
): Promise<OpenedRunSession> {
  const { store } = d;
  // A memory that cannot be read must not keep the bot from answering.
  const botMemory = await promptMemory(
    d.memory,
    { kind: "bot", botId: scope.bot.id },
    d.limits.memoryPromptChars,
    d.log,
    // A group session gets only the bot's rules and lessons: its facts may come from the owner's direct chat.
    scope.groupId ? GROUP_SESSION_KINDS : undefined,
  );
  const memory = botMemory ?? "";
  // The owner's rules are whole (never cut by the memory cap) and read at every open, so an edit reaches the next run.
  const rules = await readRulesText(d.memory, { kind: "bot", botId: scope.bot.id }, d.log);
  const groupRules = scope.groupId
    ? await readRulesText(d.memory, { kind: "group", groupId: scope.groupId }, d.log)
    : "";
  const group = scope.groupId ? await store.groups.get(scope.groupId) : undefined;
  const groupContext = group ? await groupContextFor(group, d.projectRules) : undefined;
  const groupRead = scope.groupId
    ? await groupMemoryFor(scope.groupId, d.memory, d.limits.groupMemoryPromptChars, d.log)
    : undefined;
  const groupMemory = groupRead?.text;
  // A part whose read failed is not "now empty": it is left out of the block and keeps its stored hash.
  const skip: StatePart[] = [
    ...(botMemory === undefined ? (["memory"] as const) : []),
    ...(rules === undefined ? (["rules"] as const) : []),
    ...(groupRules === undefined ? (["groupRules"] as const) : []),
    ...(groupRead?.failed ? (["groupMemory"] as const) : []),
  ];
  // A direct session gets the teammate directory; a group session's roster is in its group context.
  const teammates = scope.groupId
    ? undefined
    : teammateDirectory(scope.bot.id, await store.bots.list());
  // The scope's open items (a done one is not injected); each scope has its own list.
  const scratchpad = scratchpadBlock(
    (await store.scratchpad.list(scope.key)).filter((i) => i.status !== "done"),
  );
  const computerContext = computerContextBlock(scope.bot);
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
    ...(teammates && { teammates }),
    ...(scratchpad && { scratchpad }),
    ...(computerContext && { computerContext }),
  };
  const stored = fresh ? undefined : await store.sessions.get(scope.key);
  let session: BotSession | undefined;
  let resumed = false;
  try {
    if (stored) {
      try {
        session = await d.runtime.resume(stored, full);
        resumed = true;
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
  const parts = stateParts(full);
  // A new session has every part in its system prompt; a resumed one has the prompt it started with.
  const seen = resumed ? ((await store.sessions.stateGet(scope.key)) ?? {}) : undefined;
  const block = seen && stateChangedBlock(parts, seen, skip);
  const hashes = seen ? nextStateHashes(parts, seen, skip) : stateHashes(parts);
  // A failed save only sends the same block again at the next open; it never fails the delivered turn.
  let committed = false;
  const commitState = async () => {
    if (committed) return;
    committed = true;
    try {
      await store.sessions.stateSet(scope.key, hashes);
    } catch (err) {
      d.log?.warn({ scope: scope.key, err: errText(err) }, "session.state_save_failed");
    }
    if (block) d.log?.info({ scope: scope.key, parts: block.changed }, "session.state_changed");
  };
  return {
    session,
    memory: `${memory}\n${groupMemory ?? ""}`,
    ...(block && { stateChanged: block.text }),
    commitState,
  };
}
