import type { PermissionMode, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { logEvent, logger } from "../observability/logger";
import type { ModeActive } from "./permission-mode";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "permission-watch" });

/**
 * Per-run watcher of the SDK stream for the permission layer:
 * - init message: logs the ACTUAL permission mode once (`permission.mode`); when auto was requested but the SDK
 *   runs another mode (unsupported model / plan / org policy: a silent fallback) it warns and switches
 *   `auto.active` off, so guard asks go to the owner again and `tool.done` logs "ask", not "auto". Same for
 *   `bypassPermissions` and `bypass.active` (fail closed: a stage that is not really in bypass asks the owner).
 * - `permission_denied` from the classifier: `tool.denied` with `by: "classifier"` (tool name and id only, no content).
 */
export function createPermissionWatch(
  requested: PermissionMode | undefined,
  auto: ModeActive,
  bypass: ModeActive = { active: false },
): (msg: SDKMessage) => void {
  let modeLogged = false;
  return (msg) => {
    if (msg.type !== "system") return;
    const m = msg as {
      subtype?: string;
      permissionMode?: PermissionMode;
      tool_name?: string;
      tool_use_id?: string;
      decision_reason_type?: string;
    };
    if (m.subtype === "init" && !modeLogged) {
      modeLogged = true;
      const actual = m.permissionMode;
      const fallback =
        (auto.active && actual !== "auto") || (bypass.active && actual !== "bypassPermissions");
      if (fallback) {
        auto.active = false;
        bypass.active = false;
      }
      logEvent(
        log,
        "permission.mode",
        { requested, actual, ...(fallback && { fallback }) },
        fallback ? "warn" : "info",
      );
    } else if (m.subtype === "permission_denied" && m.decision_reason_type === "classifier") {
      logEvent(
        log,
        "tool.denied",
        { by: "classifier", tool: m.tool_name, toolUseId: m.tool_use_id },
        "warn",
      );
    }
  };
}
