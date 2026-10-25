import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntime, BotRuntimeSpec, BotSession } from "@friday/core";
import { buildOptions, type ClaudeRuntimeConfig } from "./session/build-options";
import { createCallGuard } from "./session/call-guard";
import { ClaudeSession } from "./session/claude-session";
import { createInputQueue } from "./session/input-queue";
import { scratchName } from "./session/scratch-name";

export type { ClaudeRuntimeConfig } from "./session/build-options";

/**
 * `AgentRuntime` on the Claude Agent SDK: one streaming session per bot and scope (direct or group), background
 * subagents allowed.
 */
export class ClaudeRuntime implements AgentRuntime {
  constructor(private readonly config: ClaudeRuntimeConfig) {}

  /** Start a new session. Returns at once: the id is ours (the SDK is told to use it), not read from `init`. */
  async open(spec: BotRuntimeSpec): Promise<BotSession> {
    return this.start(spec, undefined);
  }

  /**
   * Continue a stored session. Throws when the SDK no longer has its transcript (cleaned up, other cwd, wiped home),
   * so the caller can drop the stored id and open a fresh session instead of crashing on it forever.
   */
  async resume(sessionId: string, spec: BotRuntimeSpec): Promise<BotSession> {
    const dir = spec.bot.workspaces[0] ?? join(this.config.scratchRoot, scratchName(spec));
    const exists =
      this.config.sessionExists ??
      (async (id: string, d: string) => !!(await getSessionInfo(id, { dir: d })));
    if (!(await exists(sessionId, dir))) throw new Error(`session ${sessionId} not found`);
    return this.start(spec, sessionId);
  }

  /**
   * Create the scratch dir, the input queue, the call guard and the SDK stream, and wrap them in a session. A guard
   * stop in the hook reaches the session, which ends its events with a `guard_stop`.
   */
  private start(spec: BotRuntimeSpec, resume: string | undefined): ClaudeSession {
    const { bot } = spec;
    const scratchDir = join(this.config.scratchRoot, scratchName(spec));
    mkdirSync(scratchDir, { recursive: true });
    const queue = createInputQueue();
    const abort = new AbortController();
    const id = resume ?? randomUUID();
    const guard = createCallGuard({ maxToolCallsPerTurn: spec.maxToolCallsPerTurn ?? 0 });
    let session: ClaudeSession | undefined;
    const options = buildOptions({
      spec,
      config: this.config,
      resume,
      sessionId: resume ? undefined : id,
      abort,
      scratchDir,
      guard,
      onGuardStop: (text) => session?.guardStop(text),
    });
    const run = (this.config.queryFn ?? query)({ prompt: queue.iterable, options });
    // `SetEffort` reaches the live query through the holder the app put on the spec.
    if (spec.effortControl) {
      const control = spec.effortControl;
      control.current = bot.effort;
      control.apply = async (level) => {
        await run.applyFlagSettings({ effortLevel: level });
        control.current = level;
      };
    }
    session = new ClaudeSession(
      id,
      queue,
      abort,
      run[Symbol.asyncIterator](),
      { [bot.id]: bot.name },
      scratchDir,
      guard,
    );
    return session;
  }
}
