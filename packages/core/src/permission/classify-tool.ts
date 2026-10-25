import type { RiskClass } from "../domain/autonomy";
import type { ToolCall, ToolSpec } from "../domain/tool";
import { externalServerOf } from "./taint-policy";
import { nameRisk } from "./tool-name-risk";

/**
 * What kind of call a tool makes. A tool of an external MCP server is first judged by its name (spec §6.14):
 * a mutating name is `write` (`external` with an open-world hint, `destructive` with a destructive hint) and
 * a server's `readOnlyHint` never lifts it; a read name is `read` unless the server says destructive or
 * not read-only; an unrecognised name falls through to the hints. Every other tool uses its annotations:
 * a tool with none that is not sandboxed is `unknown`. Order: read-only, sandboxed (local), destructive
 * (a missing hint counts as destructive), open-world (external), else write.
 * `tool` is the called name, for a tool the catalog has no spec for.
 */
export function classifyTool(spec: ToolSpec | undefined, tool = spec?.name): RiskClass {
  const a = spec?.annotations ?? {};
  if (tool && externalServerOf(tool)) {
    const risk = nameRisk(tool);
    if (risk === "consequential" || (risk === "read" && a.readOnlyHint === false)) {
      if (a.destructiveHint) return "destructive";
      return a.openWorldHint ? "external" : "write";
    }
    if (risk === "read") return a.destructiveHint ? "destructive" : "read";
  }
  if (!spec || (!spec.annotations && !spec.sandboxed)) return "unknown";
  if (a.readOnlyHint) return "read";
  if (spec.sandboxed) return "local";
  if (a.destructiveHint ?? true) return "destructive"; // a hint left out means the MCP default: destructive
  if (a.openWorldHint) return "external";
  return "write";
}

/**
 * True when a call cannot be undone: destructive, not idempotent and open-world. An annotated tool that
 * leaves a hint out gets the MCP default (destructive, not idempotent, open-world). A read-only, a
 * sandboxed or an unannotated tool is never irreversible (unannotated tools are asked once instead).
 */
export function isIrreversible(spec: ToolSpec | undefined): boolean {
  if (!spec?.annotations || spec.sandboxed) return false;
  const a = spec.annotations;
  if (a.readOnlyHint) return false;
  return (a.destructiveHint ?? true) && !(a.idempotentHint ?? false) && (a.openWorldHint ?? true);
}

/** The values of the tool's scope keys in the call, as strings (a missing key is ""; an object is its JSON). */
export function scopeOf(call: ToolCall, spec: ToolSpec | undefined): Record<string, string> {
  const scope: Record<string, string> = {};
  for (const key of spec?.scopeKeys ?? []) {
    const v = call.input[key];
    scope[key] =
      v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return scope;
}
