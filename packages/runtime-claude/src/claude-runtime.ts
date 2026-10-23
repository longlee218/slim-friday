import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntime, BotRuntimeSpec, BotSession } from "@friday/core";
import { buildOptions, type ClaudeRuntimeConfig } from "./session/build-options";
import { ClaudeSession } from "./session/claude-session";
import { createInputQueue } from "./session/input-queue";

export type { ClaudeRuntimeConfig } from "./session/build-options";

/** `AgentRuntime` on the Claude Agent SDK: one streaming session per bot, background subagents allowed. */
export class ClaudeRuntime implements AgentRuntime {
  constructor(private readonly config: ClaudeRuntimeConfig) {}

  /** Start a new session. Returns at once: the id is ours (the SDK is told to use it), not read from `init`. */
  open(spec: BotRuntimeSpec): Promise<BotSession> {
    return Promise.resolve(this.start(spec, undefined));
  }

  /** Continue a stored session. */
  resume(sessionId: string, spec: BotRuntimeSpec): Promise<BotSession> {
    return Promise.resolve(this.start(spec, sessionId));
  }

  /** Create the scratch dir, the input queue and the SDK stream, and wrap them in a session. */
  private start(spec: BotRuntimeSpec, resume: string | undefined): ClaudeSession {
    const { bot } = spec;
    const scratchDir = join(this.config.scratchRoot, bot.id);
    mkdirSync(scratchDir, { recursive: true });
    const queue = createInputQueue();
    const abort = new AbortController();
    const id = resume ?? randomUUID();
    const options = buildOptions({
      spec,
      config: this.config,
      resume,
      sessionId: resume ? undefined : id,
      abort,
      scratchDir,
    });
    const run = (this.config.queryFn ?? query)({ prompt: queue.iterable, options });
    return new ClaudeSession(id, queue, abort, run[Symbol.asyncIterator](), { [bot.id]: bot.name });
  }
}
