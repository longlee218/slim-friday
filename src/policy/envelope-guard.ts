import { CREATE_PULL_REQUEST_TOOL } from "../mcp/effects/tools/CreatePullRequestTool/constants";
import { EFFECTS_MCP_SERVER, mcpToolName } from "../mcp/mcp-tool-names";
import { EFFECT_TOOL_NAMES } from "../orchestrator/effects/effect-tool-names";
import { checkEnvelope } from "./check-envelope";
import type { Decision, GuardrailContext } from "./check-tool-call";
import { classifyToolCall } from "./classify-tool-call";
import type { EffectTool } from "./risk-types";

/* The envelope gate of `checkToolCall`: a worker run with an envelope. Fail closed: what the envelope does not cover is
   denied with `OUT_OF_ENVELOPE`, and the worker reports BLOCKED so the teammate can ask for an amendment. */

/** Reason of a call outside the envelope (never echoes the call). */
const OUTSIDE = (why: string): Decision => ({
  decision: "deny",
  reason: `OUT_OF_ENVELOPE: ${why}; report a blocker with what you need`,
});

/** The effect tool a full MCP tool name is, or undefined. */
const effectToolOf = (name: string): EffectTool | undefined =>
  EFFECT_TOOL_NAMES.find((t) => name === mcpToolName(EFFECTS_MCP_SERVER, t));

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Gate decision `d` (the base guard's) for a run with an envelope. An effect tool must be granted for the location /
 * branch it names (the tool re-checks with the measured size and asks for R4); a call the base guard would ask about is
 * classified: its class must be one the envelope allows, else it is denied. Allowed calls stay as they are.
 */
export function envelopeGate(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
  d: Decision,
): Decision {
  const env = ctx.envelope;
  if (!env || d.decision === "deny") return d;
  const effect = effectToolOf(toolName);
  if (effect) {
    const v = checkEnvelope(
      {
        tool: effect,
        location: str(input.location),
        branch: str(effect === CREATE_PULL_REQUEST_TOOL ? input.head : input.branch),
        into: str(input.into),
      },
      env,
    );
    // R4 (a default branch): the tool asks the owner at this act, so the call may reach it.
    return v.allow || v.code === "R4" ? d : OUTSIDE(v.reason);
  }
  if (d.decision !== "ask") return d;
  const risk = classifyToolCall(toolName);
  return risk !== "R4" && (risk === "R0" || risk === "R1" || env.classes.includes(risk))
    ? d
    : OUTSIDE("this tool is not covered by the plan");
}
