import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { Decision } from "../guardrails/check-tool-call";
import { isInside, resolveReal } from "../guardrails/paths";
import { BASH_TOOL_NAME } from "../tools/sdk-tool-names";
import { loadWorkspaces } from "../workspaces/workspace-registry";
import { getLogContext, logEvent, logger, setLogContext, tryLog } from "./logger";
import type { RunRecorder } from "./record-run";
import { safePreview } from "./redact";

/** Repos (real paths) per workspace per AGENT_HOME, shared by all tasks; refreshed after REPO_TTL_MS. */
const repoCache = new Map<
  string,
  { at: number; byWorkspace: Map<string, { name: string; path: string }[]> }
>();
const REPO_TTL_MS = 30_000;

/**
 * Repo of workspace `ws` (real path) containing the file/dir a tool call touches, else undefined.
 * Only repos of that workspace are considered: a same-named repo elsewhere is never matched.
 */
export function repoOfTool(
  home: string,
  ws: string,
  tool: string,
  input: unknown,
): string | undefined {
  // Bash is skipped: its cwd-independent paths cannot be told from the command text.
  if (tool === BASH_TOOL_NAME || !input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const p = [i.file_path, i.path].find((v): v is string => typeof v === "string" && v !== "");
  if (!p) return undefined;
  let hit = repoCache.get(home);
  if (!hit || Date.now() - hit.at > REPO_TTL_MS) {
    const byWorkspace = new Map(
      loadWorkspaces(home).workspaces.map((w) => [
        w.name,
        w.repos.map((r) => ({ name: r.name, path: resolveReal(r.path) })),
      ]),
    );
    hit = { at: Date.now(), byWorkspace };
    repoCache.set(home, hit);
  }
  const real = resolveReal(p);
  return hit.byWorkspace.get(ws)?.find((r) => isInside(r.path, real))?.name;
}

/**
 * Pre/PostToolUse(+Failure) hooks that time each tool call, store it via the recorder and log it
 * as `tool.call` (with the guard decision from `decisions`, when a guard ran).
 */
export function buildToolHooks(
  recorder: RunRecorder,
  decisions?: Map<string, Decision>,
  /** AGENT_HOME: enables attributing a tool call to the registered repo whose files it touches. */
  agentHome?: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const log = logger.child({ module: "tool-hooks" });
  /** tool_use_id -> start timestamp, fallback when the SDK gives no duration_ms. */
  const started = new Map<string, number>();

  /** Hook callbacks must never throw into the SDK: log (redacted) and continue. */
  const guard = (fn: () => void) => tryLog(log, "tool hook failed", fn);

  /** Shared finish logic for success and failure events. */
  const done = (
    id: string,
    tool: string,
    input: unknown,
    output: unknown,
    isError: boolean,
    sdkMs?: number,
  ) => {
    const t0 = started.get(id);
    started.delete(id);
    const durationMs = sdkMs ?? (t0 ? Date.now() - t0 : 0);
    recorder.recordToolCall({ id, tool, input, output, isError, durationMs });
    // No guard (unit tests) = no decision recorded.
    const d = decisions?.get(id);
    decisions?.delete(id);
    // Unpinned task ("*"): the first call into a repo of the task's workspace names the repo on this line
    // (explicit field wins over the mixin) and sets the context so later lines (task.finished...) carry it.
    let repo: string | undefined;
    const workspace = getLogContext().workspace;
    if (agentHome && workspace) {
      try {
        repo = repoOfTool(agentHome, workspace, tool, input);
      } catch {
        repo = undefined; // unresolvable path: keep the context repo
      }
      if (repo && getLogContext().repo === "*") setLogContext({ repo });
      else repo = undefined; // pinned/known repo: the mixin already carries it
    }
    logEvent(log, "tool.call", {
      ...(repo && { repo }),
      tool,
      decision: d?.decision ?? "allow",
      ...(d && { reason: d.reason }),
      durationMs,
      isError,
      input: safePreview(input, 300),
    });
  };

  return {
    PreToolUse: [
      {
        hooks: [
          async (i) => {
            if (i.hook_event_name === "PreToolUse")
              guard(() => started.set(i.tool_use_id, Date.now()));
            return { continue: true };
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (i) => {
            if (i.hook_event_name === "PostToolUse")
              guard(() =>
                done(
                  i.tool_use_id,
                  i.tool_name,
                  i.tool_input,
                  i.tool_response,
                  false,
                  i.duration_ms,
                ),
              );
            return { continue: true };
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          async (i) => {
            if (i.hook_event_name === "PostToolUseFailure")
              guard(() =>
                done(i.tool_use_id, i.tool_name, i.tool_input, i.error, true, i.duration_ms),
              );
            return { continue: true };
          },
        ],
      },
    ],
  };
}
