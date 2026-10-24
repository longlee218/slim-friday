import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpProbe, McpProbeResult, McpServerInput } from "@friday/core";

/** Longest error text returned to the caller. */
const MAX_ERROR_CHARS = 300;
/** How often the server status is read while it is still starting. */
const POLL_MS = 250;
/** Default wait for a server to leave `pending`. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** The SDK server config for an owner's definition (optional fields are left out, not set to undefined). */
function toSdkServer(s: McpServerInput) {
  if (s.type === "http")
    return { type: "http" as const, url: s.url, ...(s.headers && { headers: s.headers }) };
  return {
    type: "stdio" as const,
    command: s.command,
    ...(s.args && { args: s.args }),
    ...(s.env && { env: s.env }),
  };
}

/**
 * Builds an `McpProbe`: starts the server through one SDK `query` whose prompt never yields a message (so no model
 * call is made), reads `mcpServerStatus()` until the server leaves `pending` or the time is up, then ends the query.
 */
export function createMcpProbe(deps: {
  /** The child env of the SDK process (already expanded and scrubbed by the caller). */
  env: Record<string, string>;
  timeoutMs?: number;
  /** The SDK `query`; tests inject a fake. */
  query?: typeof query;
}): McpProbe {
  const run = deps.query ?? query;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (name, server): Promise<McpProbeResult> => {
    // An input stream that stays open and yields nothing until `finish` ends it.
    let finish: () => void = () => {};
    const closed = new Promise<void>((r) => {
      finish = r;
    });
    const prompt: AsyncIterable<never> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await closed;
          return { done: true, value: undefined };
        },
      }),
    };
    const q = run({
      prompt,
      options: {
        mcpServers: { [name]: toSdkServer(server) },
        settingSources: [],
        tools: [],
        env: deps.env,
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A timer, not the clock: the runtime reads no wall clock.
      let expired = false;
      timer = setTimeout(() => {
        expired = true;
      }, timeoutMs);
      while (!expired) {
        const s = (await q.mcpServerStatus()).find((x) => x.name === name);
        if (s && s.status !== "pending") {
          if (s.status === "connected") {
            return { status: "connected", tools: (s.tools ?? []).map((t) => t.name) };
          }
          if (s.status === "needs-auth") return { status: "needs-auth" };
          return { status: "failed", error: (s.error ?? s.status).slice(0, MAX_ERROR_CHARS) };
        }
        await Bun.sleep(POLL_MS);
      }
      return { status: "failed", error: "timed out" };
    } catch (e) {
      return {
        status: "failed",
        error: (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_CHARS),
      };
    } finally {
      clearTimeout(timer);
      await q.interrupt().catch(() => {});
      finish();
    }
  };
}
