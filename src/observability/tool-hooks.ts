import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { logger, tryLog } from "./logger";
import type { RunRecorder } from "./record-run";

/** Pre/PostToolUse(+Failure) hooks that time each tool call and store it via the recorder. */
export function buildToolHooks(
  recorder: RunRecorder,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  /** tool_use_id -> start timestamp, fallback when the SDK gives no duration_ms. */
  const started = new Map<string, number>();

  /** Hook callbacks must never throw into the SDK: log (redacted) and continue. */
  const guard = (fn: () => void) =>
    tryLog(logger.child({ module: "tool-hooks" }), "tool hook failed", fn);

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
    recorder.recordToolCall({
      id,
      tool,
      input,
      output,
      isError,
      durationMs: sdkMs ?? (t0 ? Date.now() - t0 : 0),
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
