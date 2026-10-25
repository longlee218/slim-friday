import type { AutonomyLevel, Outcome, PermissionSettings, RiskClass } from "../domain/autonomy";
import type { Grant } from "../domain/grant";
import type { ToolCall, ToolSpec } from "../domain/tool";
import { classifyTool, isIrreversible, scopeOf } from "./classify-tool";
import { RULE_SPECIFICITY, resolveRule } from "./match-grant";
import { mcpServerOf, type TaintAsk } from "./taint-policy";
import { categoryOf } from "./tool-name-risk";

/** What each autonomy level does with each class of call, before owner rules and overrides. */
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
  /** The owner rules of the bot (its own and every bot's), `always_allow` and `require_approval`. */
  grants: Grant[];
  settings: PermissionSettings;
  /** Set by the runtime when a hard rule (sandbox, credential path) already forbids the call. */
  floorDenyReason?: string;
  now: number;
  /** The taint ask of the call in a tainted run (`taintAskOf`); unset when none applies. */
  taint?: TaintAsk;
  /** Registrable domain of a `WebFetch` url (`fetchSiteOf`); unset for other tools or a host with none. */
  site?: string;
}

/** The decision; `always` names the kind of "Always allow" rule the card may offer (unset: no "Always"). */
export interface Decision {
  outcome: Outcome;
  reason: string;
  always?: "site" | "tool";
}

/**
 * Decide one tool call (spec §6.14). Order: hard floor (deny), per-tool deny, mandatory asks (instruction change
 * in a tainted run), the other taint asks (they yield only to an `always_allow` site rule, or for an MCP call a
 * tool or server rule), per-tool override, owner rule (`require_approval` asks, `always_allow` allows), then the
 * autonomy level for the tool's class. An irreversible or destructive-class call is never lifted by an
 * `always_allow` rule and its ask is `ask_always`. Auto Review (Task 17) goes after the level's ask.
 */
export function decide(input: DecideInput): Decision {
  const { call, spec, grants, settings, now } = input;
  if (input.floorDenyReason) return { outcome: "deny", reason: input.floorDenyReason };
  const cls = classifyTool(spec, call.tool);
  // No permanent permission for what cannot be undone or destroys: never lifted by a rule, never "Always".
  const irreversible = isIrreversible(spec);
  const noAlways = irreversible || cls === "destructive";
  const override = settings.tools?.[call.tool];
  if (override === "deny") return { outcome: "deny", reason: "tool override" };
  const taint = input.taint;
  if (taint?.mandatory) return { outcome: "ask_always", reason: `tainted: ${taint.reason}` };
  const server = mcpServerOf(call.tool);
  const category = server ? categoryOf(call.tool, server) : undefined;
  const rule = resolveRule(grants, call, {
    ...(input.site && { site: input.site }),
    ...(server && { server }),
    ...(category && { category }),
    scope: scopeOf(call, spec),
    now,
  });
  const allowRule = rule?.effect === "always_allow" && !noAlways ? rule : undefined;
  const required = rule?.effect === "require_approval" ? RULE_SPECIFICITY[rule.match] : 0;
  const fetch = call.tool === "WebFetch";
  // "Always" on a fetch is the site, never the whole tool; it is offered only when it would beat a require rule.
  const kind = fetch ? (input.site ? "site" : undefined) : "tool";
  const always = kind && !noAlways && RULE_SPECIFICITY[kind] > required ? kind : undefined;
  const ask = (reason: string): Decision =>
    noAlways
      ? {
          outcome: "ask_always",
          reason: `${reason}; ${irreversible ? "cannot be undone" : "destructive"}`,
        }
      : { outcome: "ask", reason, ...(always && { always }) };
  if (taint) {
    const yields =
      allowRule &&
      (allowRule.match === "site" || (!fetch && ["tool", "server"].includes(allowRule.match)));
    // A taint card never offers "Always" for the tool; a fetch card may offer its site.
    if (!yields)
      return {
        outcome: "ask_always",
        reason: `tainted: ${taint.reason}`,
        ...(always === "site" && { always }),
      };
  }
  if (override === "ask") return ask("tool override");
  if (override) return { outcome: override, reason: "tool override" };
  if (rule?.effect === "require_approval") return ask(`rule ${rule.id}: require approval`);
  if (allowRule) return { outcome: "allow", reason: `rule ${allowRule.id}` };
  const level = settings.botLevels?.[call.botId] ?? settings.level;
  const reason = `${level}: ${cls}`;
  // Task 17 (Auto Review) adds its step here, for an ask that is not mandatory.
  return LEVEL_MAP[level][cls] === "ask" ? ask(reason) : { outcome: "allow", reason };
}
