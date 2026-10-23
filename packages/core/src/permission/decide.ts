import type { AutonomyLevel, Outcome, PermissionSettings, RiskClass } from "../domain/autonomy";
import type { Grant } from "../domain/grant";
import type { ToolCall, ToolSpec } from "../domain/tool";
import { classifyTool, isIrreversible, scopeOf } from "./classify-tool";
import { matchGrant } from "./match-grant";

/** What each autonomy level does with each class of call, before grants and overrides. */
export const LEVEL_MAP: Record<AutonomyLevel, Record<RiskClass, "allow" | "ask">> = {
  careful: {
    read: "allow",
    local: "ask",
    write: "ask",
    external: "ask",
    destructive: "ask",
    unknown: "ask",
  },
  balanced: {
    read: "allow",
    local: "allow",
    write: "ask",
    external: "ask",
    destructive: "ask",
    unknown: "ask",
  },
  autonomous: {
    read: "allow",
    local: "allow",
    write: "allow",
    external: "allow",
    destructive: "ask",
    unknown: "ask",
  },
};

export interface DecideInput {
  call: ToolCall;
  spec: ToolSpec | undefined;
  grants: Grant[];
  settings: PermissionSettings;
  /** Set by the runtime when a hard rule (sandbox, credential path) already forbids the call. */
  floorDenyReason?: string;
  now: number;
}

/**
 * Decide one tool call. Order: hard floor (deny), per-tool override, matching grant (allow), then the
 * autonomy level for the tool's class. An `ask` on an irreversible call becomes `ask_always`
 * (no "Always allow" offered).
 */
export function decide(input: DecideInput): { outcome: Outcome; reason: string } {
  const { call, spec, grants, settings, now } = input;
  if (input.floorDenyReason) return { outcome: "deny", reason: input.floorDenyReason };
  const override = settings.tools?.[call.tool];
  if (override) return { outcome: override, reason: "tool override" };
  const grant = matchGrant(grants, call, scopeOf(call, spec), now);
  if (grant) return { outcome: "allow", reason: `grant ${grant.id}` };
  const cls = classifyTool(spec);
  const level = settings.botLevels?.[call.botId] ?? settings.level;
  const outcome = LEVEL_MAP[level][cls];
  if (outcome === "ask" && isIrreversible(spec))
    return { outcome: "ask_always", reason: `${cls} call that cannot be undone` };
  return { outcome, reason: `${level}: ${cls}` };
}
