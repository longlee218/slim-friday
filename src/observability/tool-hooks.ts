import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { LoggedDecision } from "../policy/check-tool-call";
import { READ_ONLY_REASON } from "../policy/deny-dangerous";
import { isInside, resolveReal } from "../policy/paths";
import { BASH_TOOL_NAME } from "../tools/sdk-tool-names";
import { loadWorkspaces } from "../workspaces/workspace-registry";
import { getLogContext, logEvent, logger, setLogContext, tryLog } from "./logger";
import type { RunRecorder } from "./record-run";
import { agentIdentity, buildSubagentHooks } from "./subagent-hooks";
import { inputPreview, scrubEditError } from "./tool-input-preview";
import { summarizeResult } from "./tool-result-summary";
import { describeTool, EDIT_TOOLS } from "./tool-target";

/** Locations (real paths) per workspace per AGENT_HOME, shared by all tasks; refreshed after LOCATION_TTL_MS. */
const locationCache = new Map<
  string,
  { at: number; byWorkspace: Map<string, { name: string; path: string }[]> }
>();
const LOCATION_TTL_MS = 30_000;

/**
 * Location of workspace `ws` (real path) containing the file/dir a tool call touches, else undefined.
 * Only locations of that workspace are considered: a same-named location elsewhere is never matched.
 */
export function locationOfTool(
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
  let hit = locationCache.get(home);
  if (!hit || Date.now() - hit.at > LOCATION_TTL_MS) {
    const byWorkspace = new Map(
      loadWorkspaces(home).workspaces.map((w) => [
        w.name,
        w.locations.map((r) => ({ name: r.name, path: resolveReal(r.path) })),
      ]),
    );
    hit = { at: Date.now(), byWorkspace };
    locationCache.set(home, hit);
  }
  const real = resolveReal(p);
  return hit.byWorkspace.get(ws)?.find((r) => isInside(r.path, real))?.name;
}

/** Options of `buildToolHooks`. */
export interface ToolHookOptions {
  /** Guard decision per tool_use_id; a non-default one is added to the `tool.done` line. */
  decisions?: Map<string, LoggedDecision>;
  /** AGENT_HOME: enables attributing a tool call to the registered location whose files it touches. */
  agentHome?: string;
  /** Directories paths are shown relative to in `target` (cwd + additional dirs). */
  roots?: string[];
}

/** Hook options of one run: guard decisions, home, and the cwd + extra dirs targets are shown relative to. */
export function hookOptions(
  perms: { decisions: Map<string, LoggedDecision> } | undefined,
  config: { agentHome: string },
  input: { cwd: string; additionalDirectories?: string[] },
): ToolHookOptions {
  return {
    decisions: perms?.decisions,
    agentHome: config.agentHome,
    roots: [input.cwd, ...(input.additionalDirectories ?? [])],
  };
}

/**
 * Pre/PostToolUse(+Failure) hooks that time each tool call, store it via the recorder and log it
 * as a `tool.start` / `tool.done` pair correlated by `toolUseId` (sizes only, never result text).
 */
export function buildToolHooks(
  recorder: RunRecorder,
  { decisions, agentHome, roots = [] }: ToolHookOptions = {},
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const log = logger.child({ module: "tool-hooks" });
  /** tool_use_id -> start timestamp, fallback when the SDK gives no duration_ms. */
  const started = new Map<string, number>();

  /** Hook callbacks must never throw into the SDK: log (redacted) and continue. */
  const guard = (fn: () => void) => tryLog(log, "tool hook failed", fn);

  /** Shared finish logic for success and failure events (`i` is the Post hook input). */
  const done = (
    i: {
      tool_use_id: string;
      tool_name: string;
      tool_input: unknown;
      duration_ms?: number;
      agent_id?: string;
      agent_type?: string;
    },
    output: unknown,
    isError: boolean,
  ) => {
    const { tool_use_id: id, tool_name: tool, tool_input: input, duration_ms: sdkMs } = i;
    const who = agentIdentity(i);
    const t0 = started.get(id);
    started.delete(id);
    const durationMs = sdkMs ?? (t0 ? Date.now() - t0 : 0);
    recorder.recordToolCall({ id, tool, input, output, isError, durationMs, agentId: who.agentId });
    // No guard (unit tests) = no decision recorded.
    const d = decisions?.get(id);
    decisions?.delete(id);
    // Unpinned task ("*"): the first call into a location of the task's workspace names the location on this line
    // (explicit field wins over the mixin) and sets the context so later lines (task.finished...) carry it.
    let location: string | undefined;
    const workspace = getLogContext().workspace;
    if (agentHome && workspace) {
      try {
        location = locationOfTool(agentHome, workspace, tool, input);
      } catch {
        location = undefined; // unresolvable path: keep the context location
      }
      if (location && getLogContext().location === "*") setLogContext({ location });
      else location = undefined; // pinned/known location: the mixin already carries it
    }
    const r = summarizeResult(output, isError);
    // An edit error echoes the file text it failed to match: keep only its first line.
    if (r.err && EDIT_TOOLS.includes(tool)) r.err = scrubEditError(r.err, input);
    logEvent(log, "tool.done", {
      ...(location && { location }),
      ...who,
      tool,
      toolUseId: id,
      target: describeTool(tool, input, roots).target,
      ok: !isError,
      durationMs,
      ...r,
      // Only the unusual: an owner-approved call or a non-default allow reason.
      ...(d &&
        (d.decision === "ask" || d.reason !== READ_ONLY_REASON) && {
          decision: d.decision,
          reason: d.reason,
        }),
      input: inputPreview(input),
    });
  };

  return {
    ...buildSubagentHooks(),
    PreToolUse: [
      {
        hooks: [
          async (i) => {
            if (i.hook_event_name === "PreToolUse")
              guard(() => {
                started.set(i.tool_use_id, Date.now());
                logEvent(log, "tool.start", {
                  ...agentIdentity(i),
                  tool: i.tool_name,
                  toolUseId: i.tool_use_id,
                  target: describeTool(i.tool_name, i.tool_input, roots).target,
                });
              });
            return { continue: true };
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (i) => {
            if (i.hook_event_name === "PostToolUse") guard(() => done(i, i.tool_response, false));
            return { continue: true };
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          async (i) => {
            if (i.hook_event_name === "PostToolUseFailure") guard(() => done(i, i.error, true));
            return { continue: true };
          },
        ],
      },
    ],
  };
}
