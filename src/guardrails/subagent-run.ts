/**
 * Run-scoped subagent state and the STATEFUL guard rules (the stateless ones are `checkSpawn` / `checkMessage` in
 * `subagent-guard.ts`). One state object per agent run, created by the permission layer and mutated only by the guard
 * hook: it counts spawns and resumes, in-flight spawns, and remembers which names / agent ids this run started.
 * The pure `checkToolCall` never reads it, so the canUseTool path cannot double count.
 *
 * Fail closed: SendMessage is allowed only for a target this run spawned. Spike Q19 saw a `name` as `to` work; an
 * agentId as `to` and an unknown target were NOT observed, so both are treated by tracking: allowed only when known
 * here, denied otherwise.
 */
import {
  AGENT_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
} from "../tools/sdk-tool-names";
import type { Decision } from "./check-tool-call";

/** Spawn cap per run (code constant, owner-set): every Agent spawn AND every SendMessage resume counts. SDD needs about 2N+1 plus 2 per fix round. */
export const MAX_SUBAGENT_SPAWNS = 40;
/** Foreground subagents running at once (parallel Agent calls of one turn). */
export const MAX_PARALLEL_SUBAGENTS = 2;

/** What this run has started. */
export interface SubagentRun {
  /** `name` of every spawn let through (reserved at the Pre hook, so a duplicate is caught before the Post hook). */
  names: Set<string>;
  /** `agentId` of every finished spawn (Post hook `tool_response.agentId`). */
  agentIds: Set<string>;
  /** `tool_use_id` of the Agent calls between Pre and Post(Failure). */
  inFlight: Set<string>;
  /** Agent spawns + SendMessage resumes let through. */
  spawns: number;
}

/** A fresh state (one per run: a resumed task starts again at zero). */
export const newSubagentRun = (): SubagentRun => ({
  names: new Set(),
  agentIds: new Set(),
  inFlight: new Set(),
  spawns: 0,
});

const deny = (reason: string): Decision => ({ decision: "deny", reason });

const capReason = `subagent limit reached (${MAX_SUBAGENT_SPAWNS} starts and resumes per run): do the rest yourself or stop and report`;

/**
 * Stateful gate of a spawn the stateless rules allowed: spawn cap, concurrency cap, unique `name`. On allow the call
 * is recorded (count, in-flight, name) because the hook that asked is the only one that runs it.
 */
export function gateSpawn(
  input: Record<string, unknown>,
  toolUseId: string,
  run: SubagentRun,
): Decision | undefined {
  const name = typeof input.name === "string" ? input.name : undefined;
  if (run.spawns >= MAX_SUBAGENT_SPAWNS) return deny(capReason);
  if (run.inFlight.size >= MAX_PARALLEL_SUBAGENTS)
    return deny(
      `at most ${MAX_PARALLEL_SUBAGENTS} subagents run at once: wait for one to finish, then start the next`,
    );
  if (name && run.names.has(name))
    return deny(
      `name "${name}" is already used in this run: pick a new name, or SendMessage to resume it`,
    );
  run.spawns++;
  run.inFlight.add(toolUseId);
  if (name) run.names.add(name);
  return undefined;
}

/** Stateful gate of a SendMessage the stateless rules allowed: a target this run spawned, and the shared cap. */
export function gateResume(input: Record<string, unknown>, run: SubagentRun): Decision | undefined {
  const to = String(input.to);
  if (!run.names.has(to) && !run.agentIds.has(to))
    return deny(
      "SendMessage target unknown: `to` must be the name (or agentId) of a subagent you started in this run",
    );
  if (run.spawns >= MAX_SUBAGENT_SPAWNS) return deny(capReason);
  run.spawns++;
  return undefined;
}

/**
 * PostToolUseFailure of an Agent call: free the slot AND the reserved name (a failed spawn must not burn it).
 * Note: if neither Post hook ever fires for an allowed call (e.g. the SDK drops it after the Pre hook), its slot stays
 * in flight; the effect is a stall at the concurrency cap (denial text says to wait), never an open door.
 */
export function spawnFailed(
  run: SubagentRun,
  toolUseId: string,
  input: Record<string, unknown>,
): void {
  run.inFlight.delete(toolUseId);
  if (typeof input.name === "string") run.names.delete(input.name);
}

/** Post hook of an Agent call: it is no longer in flight; its `agentId` becomes a valid SendMessage target. */
export function spawnDone(run: SubagentRun, toolUseId: string, response: unknown): void {
  run.inFlight.delete(toolUseId);
  const id = (response as { agentId?: unknown } | null)?.agentId;
  if (typeof id === "string" && id) run.agentIds.add(id);
}

/** True for the tool that starts a subagent (`Agent`, legacy `Task`). */
export const isSpawnCall = (tool: string): boolean =>
  tool === AGENT_TOOL_NAME || tool === LEGACY_AGENT_TOOL_NAME;

/**
 * Apply the stateful rules to a MAIN-agent call the pure guard allowed (`d`): returns the deny, or `d` unchanged.
 * Only spawns and resumes are affected; every other call passes through.
 */
export function gateMainCall(
  tool: string,
  input: Record<string, unknown>,
  toolUseId: string,
  d: Decision,
  run: SubagentRun,
): Decision {
  if (d.decision !== "allow") return d;
  if (isSpawnCall(tool)) return gateSpawn(input, toolUseId, run) ?? d;
  if (tool === SEND_MESSAGE_TOOL_NAME) return gateResume(input, run) ?? d;
  return d;
}
