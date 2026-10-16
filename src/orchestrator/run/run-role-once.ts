import type { Route } from "../../config/model-routing";
import type { ThreadTitlePort } from "../../ingress/thread-rename";
import { SET_THREAD_TITLE_TOOL } from "../../mcp/orchestration/tools/SetThreadTitleTool/constants";
import { buildMemoryToolContext } from "../../memory/memory-context";
import { guardFor } from "../../policy/check-tool-call";
import { withPrefix } from "../../roles/prompts/first-prompt-prefix";
import type { RoleDefinition } from "../../roles/role-types";
import { newAskLimit } from "../../runtime/ask-limit";
import { runAgent } from "../../runtime/run-agent";
import { setProgressNote } from "../turns/progress-notes";
import type { askTimeoutControl } from "./ask-timeout-control";
import type { RoleRunInput, RoleRunnerDeps } from "./role-run-types";
import type { RoleScope } from "./role-scope-types";
import { runExtraContext } from "./run-extra-context";
import type { watchRun } from "./run-role-watch";

/** What one agent call of a role run needs besides the role input. */
interface OnceParts {
  deps: RoleRunnerDeps;
  /** The run input, budget already carrying the task's spend. */
  i: RoleRunInput;
  s: RoleScope;
  role: RoleDefinition;
  /** Fresh-session prefix (rollover seed + channel digest); empty when a session lives. */
  prefix: string;
  titlePort: ThreadTitlePort | undefined;
  supervisor: ReturnType<typeof watchRun>["supervisor"];
  ctl: ReturnType<typeof askTimeoutControl>;
}

/** The supervisor's note of a re-run (already labelled "Internal note") as a prompt head; "" when there is none. */
const rerunNote = (hint?: string): string => (hint ? `${hint}\n\n` : "");

/**
 * The function that makes ONE agent call of the run (the first run, or the supervisor's single recovery re-run with a
 * `Route` hint and a resume id): prompt, tools, guard, extra context and the owner's buttons all come from the role
 * data and the run input.
 */
export function agentRunOnce(p: OnceParts) {
  const { deps, i, s, role, prefix, titlePort, supervisor, ctl } = p;
  const { db, config, approvals } = deps;
  return (r?: Route, resumeId?: string) => {
    const route = i.route || r ? { ...i.route, ...r } : undefined;
    return runAgent({
      role,
      // The owner's text (behind the fresh-session prefix; a resume or re-run adds none). The supervisor's re-run note
      // heads the prompt: it is about this attempt, so it belongs in the turn, not in the role's standing system prompt.
      prompt: `${rerunNote(route?.internalHint)}${
        resumeId ? i.text : withPrefix(prefix, i.text, role.kind !== "lead")
      }`,
      steer: role.streaming ? deps.steer?.hook(i.threadId) : undefined,
      turnId: i.turnId,
      cwd: s.cwd,
      additionalDirectories: s.additionalDirectories,
      worktreesDir: s.worktreesDir,
      // In-process memory tools (MemorySave...): location names are read from the registry only when a tool needs them.
      memory:
        i.workspace === undefined
          ? undefined // a control-channel run has no workspace: no memory tools
          : buildMemoryToolContext({
              db,
              home: config.agentHome,
              workspace: i.workspace,
              channel: i.channel,
              channelId: i.channelId,
              locationNames: i.locations.map((r) => r.name), // channel subset: memory tools cannot reach other locations
              location: i.locations.length === 1 ? i.locations[0]?.name : undefined,
              threadId: i.threadId,
              trackSummary: role.kind !== "worker",
              threadTitle: titlePort,
              onIssue: (e) => supervisor.observe({ kind: "trusted_tool_issue", ...e }),
            }),
      onControlEvent: (e) => supervisor.observe(e),
      onProgress: (text) => setProgressNote(i.turnId, text),
      skillsWorkspace: i.workspace, // curated skills of this workspace (never location content)
      guard: guardFor(role, {
        ...s.guard,
        ...(i.noSubagents && { subagents: false }),
        ...(i.envelope && {
          envelope: i.envelope,
          // A worker reads only what it was granted (locations, goal dir, worktrees, attachments, skill dirs): never ~/.ssh, ~/.aws ...
          readPaths: s.guard.readPaths ?? [
            ...new Set([...(s.guard.writePaths ?? []), ...(s.guard.allowInside ?? [])]),
          ],
        }),
      }),
      extraContext: runExtraContext({
        db,
        config,
        i,
        s,
        role,
        hasTitlePort: !!titlePort && !!role.mcpTools?.includes(SET_THREAD_TITLE_TOOL),
      }),
      appCtx: i.appCtx,
      resume: resumeId,
      route,
      config,
      db,
      abortController: ctl.ac,
      queryFn: deps.queryFn,
      // The owner's buttons exist for a role with the ask capability; without it every `ask` is a deny.
      code: role.capabilities.includes("ask")
        ? {
            threadId: i.threadId,
            gateway: approvals,
            askLimit: newAskLimit(role.limits.maxAsk),
            onAskTimeout: ctl.onAskTimeout,
            askRelay: i.askRelay,
          }
        : undefined,
    });
  };
}
