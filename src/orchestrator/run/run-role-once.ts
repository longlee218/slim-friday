import type { Route } from "../../config/model-routing";
import type { ThreadTitlePort } from "../../ingress/thread-title";
import { buildMemoryToolContext } from "../../memory/memory-context";
import { guardFor } from "../../policy/check-tool-call";
import { withPrefix } from "../../roles/prompts/first-prompt-prefix";
import type { RoleDefinition } from "../../roles/role-types";
import { newAskLimit } from "../../runtime/ask-limit";
import { runAgent } from "../../runtime/run-agent";
import { setProgressNote } from "../turns/progress-notes";
import { touch } from "../worker/run-activity";
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
  /** Fresh-session prefix (channel digest); empty when a session lives. */
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
      // In-process memory tools (MemorySave, MemorySearch...), scoped to the run's workspace and channel.
      memory:
        i.workspace === undefined
          ? undefined // a control-channel run has no workspace: no memory tools
          : buildMemoryToolContext({
              db,
              home: config.agentHome,
              workspace: i.workspace,
              channel: i.channel,
              channelId: i.channelId,
              threadId: i.threadId,
              role: role.name,
              trackSummary: role.kind !== "worker",
              threadTitle: titlePort,
              onIssue: (e) => supervisor.observe({ kind: "trusted_tool_issue", ...e }),
              // Lead runs only: a worker's compaction writes no memory (the hooks are not even registered).
              onCompacted: deps.memoryJobs && ((req) => deps.memoryJobs?.flushAfterCompaction(req)),
            }),
      onControlEvent: (e) => supervisor.observe(e),
      onProgress: (text) => setProgressNote(i.turnId, text),
      // Every tool start of a worker run is a heartbeat for the watchdog (the lead run has no watchdog).
      onToolStart: role.kind === "worker" ? () => touch(db, i.turnId) : undefined,
      skillsWorkspace: i.workspace, // curated skills of this workspace (never location content)
      guard: guardFor(role, {
        ...s.guard,
        ...(i.envelope && {
          envelope: i.envelope,
          // A worker reads only what it was granted (locations, goal dir, attachments, skill dirs): never ~/.ssh, ~/.aws ...
          readPaths: s.guard.readPaths ?? [
            ...new Set([...(s.guard.writePaths ?? []), ...(s.guard.allowInside ?? [])]),
          ],
        }),
      }),
      extraContext: runExtraContext({ config, i, s, role }),
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
