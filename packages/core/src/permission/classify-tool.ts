import type { RiskClass } from "../domain/autonomy";
import type { ToolCall, ToolSpec } from "../domain/tool";

/**
 * What kind of call a tool makes, from its annotations. A tool with no annotations that is not
 * sandboxed is `unknown`. Order: read-only, sandboxed (local), destructive, open-world (external), else write.
 */
export function classifyTool(spec: ToolSpec | undefined): RiskClass {
  if (!spec || (!spec.annotations && !spec.sandboxed)) return "unknown";
  const a = spec.annotations ?? {};
  if (a.readOnlyHint) return "read";
  if (spec.sandboxed) return "local";
  if (a.destructiveHint) return "destructive";
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

/** The values of the tool's scope keys in the call, as strings (a missing key is ""). */
export function scopeOf(call: ToolCall, spec: ToolSpec | undefined): Record<string, string> {
  const scope: Record<string, string> = {};
  for (const key of spec?.scopeKeys ?? []) {
    const v = call.input[key];
    scope[key] = v === undefined || v === null ? "" : String(v);
  }
  return scope;
}
