import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../config/agent-config";
import { logEvent, logger } from "../observability/logger";
import type { RunLimiter } from "../orchestrator/tasks/run-limiter";
import type { QueryFn } from "../runtime/run-agent";
import { selectWorkspace } from "../workspaces/task-workspace";
import { loadWorkspaces, type Workspace } from "../workspaces/workspace-registry";
import { type MemoryCommand, parseMemoryCommand } from "./memory-commands";
import {
  COMPACT_THRESHOLD,
  type CompactLlm,
  compactTargets,
  sdkCompactLlm,
} from "./memory-compaction";
import { formatCompactResult } from "./memory-compaction-report";
import { type EditResult, ownerForget, ownerRemember } from "./memory-owner-edit";
import { type MemoryPlace, refineWriteCommand, resolveMemoryTarget } from "./memory-scope";
import { type MemoryTarget, rootTarget, workspaceTargets } from "./memory-targets";
import { ensureHome } from "./persona";

const log = logger.child({ module: "memory-command-handler" });

/** Where a message came from: a workspace channel/thread, #ops-control, or another ops channel (refused). */
export type MemoryWhere = MemoryPlace | "ops";

/** One message to check for a memory command. The owner and guild checks already ran in ingress. */
export interface MemoryRequest {
  /** Default "workspace" (so a `Task` is a valid request). */
  where?: MemoryWhere;
  /** Routing key: the parent channel of a thread, else the channel itself (maps to a workspace). */
  channelId: string;
  /** Set when typed inside a thread (default repo comes from that thread). */
  threadId?: string;
  text: string;
}

/** Returns the reply, or null when the text is not a memory command (then it is a normal task). */
export type MemoryRunner = (req: MemoryRequest) => Promise<string | null>;

/** What the runner needs. */
export interface MemoryRunnerDeps {
  db: Database;
  config: AgentConfig;
  /** Override the SDK query (tests) or the whole compaction model call. */
  queryFn?: QueryFn;
  llm?: CompactLlm;
  /** `compact memory` takes one slot like a run; remember/forget never do. */
  limiter?: RunLimiter;
}

/** Cap line after a write: exact file, `chars/cap`, advice above 80% and a notice above 100%. */
function capNote(label: string, chars: number, cap: number): string {
  const over = chars > cap ? ` ${chars - cap} oldest chars are not in prompts.` : "";
  const advice = chars > cap * COMPACT_THRESHOLD ? " Run `/compact`." : "";
  return `${label}: ${chars}/${cap}.${over}${advice}`;
}

/** Reply of a finished remember/forget: the action line plus the cap line. */
function editReply(r: EditResult, t: MemoryTarget): string {
  return r.ok && r.chars !== undefined
    ? `${r.reply}\n${capNote(t.label, r.chars, t.cap)}`
    : r.reply;
}

/**
 * Build the owner memory command runner: parses before any agent run (no LLM for remember/forget, no task row,
 * no quota). Scope rules: a workspace channel/thread may use every scope, #ops-control only `global`, other ops
 * channels nothing. Compaction covers the workspace's files (or everything from #ops-control).
 */
export function createMemoryRunner(deps: MemoryRunnerDeps): MemoryRunner {
  const home = deps.config.agentHome;

  /** Files `compact memory` covers for this place. */
  async function compactReply(
    cmd: Extract<MemoryCommand, { kind: "compact" }>,
    targets: MemoryTarget[],
  ): Promise<string> {
    const llm =
      deps.llm ?? (deps.config.hasRealAuth ? sdkCompactLlm(deps.config, deps.queryFn) : undefined);
    if (!llm) return `No credential for provider ${deps.config.provider}: cannot compact.`;
    const release = deps.limiter ? deps.limiter.tryAcquire() : () => {};
    if (!release) return "busy, runs active, try compacting again in a minute.";
    try {
      const results = await compactTargets(targets, llm, { dryRun: cmd.dryRun });
      return results.map((r) => formatCompactResult(r)).join("\n");
    } finally {
      release();
    }
  }

  return async (req) => {
    const cmd = parseMemoryCommand(req.text);
    if (!cmd) return null;
    const where = req.where ?? "workspace";
    logEvent(log, "memory.command", { kind: cmd.kind, where });
    if (cmd.kind === "invalid") return cmd.reply;
    if (where === "ops")
      return "Memory commands run in a workspace channel, or in #ops-control for global memory only.";
    let ws: Workspace | undefined;
    let all: Workspace[] = [];
    if (where === "workspace") {
      const picked = selectWorkspace(home, req.channelId);
      if ("reply" in picked) return picked.reply;
      ws = picked.ws;
    } else {
      all = loadWorkspaces(home).workspaces;
      ensureHome(home, all);
    }
    if (cmd.kind === "compact") {
      const targets = ws
        ? workspaceTargets(home, ws)
        : [rootTarget(home), ...all.flatMap((w) => workspaceTargets(home, w))];
      return compactReply(cmd, targets);
    }
    const refined = refineWriteCommand(ws, cmd);
    if ("reply" in refined) return refined.reply;
    const t = resolveMemoryTarget(
      { db: deps.db, home, ws, threadId: req.threadId, place: where },
      refined.scope,
    );
    if ("reply" in t) return t.reply;
    const result =
      cmd.kind === "remember"
        ? ownerRemember(t, refined.text, new Date().toISOString().slice(0, 10))
        : ownerForget(t, refined.text);
    logEvent(log, "memory.owner_edit", { kind: cmd.kind, file: t.label, ok: result.ok });
    return editReply(result, t);
  };
}
