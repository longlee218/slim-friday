import { parseJson } from "../format";

/** The one human line of an event payload; falls back to compact JSON for kinds with no text field. */
export function eventText(kind: string, payload: string): string {
  const p = parseJson(payload);
  if (!p || typeof p !== "object") return String(p ?? "");
  const o = p as Record<string, unknown>;
  const text = o.text ?? o.excerpt ?? o.question ?? o.note ?? o.error ?? o.reason;
  if (typeof text === "string") {
    const prefix = kind === "start" && o.key ? `${o.key} → ` : kind === "result" && o.key ? `${o.key}: ` : "";
    return prefix + text;
  }
  if (kind === "start") return `${o.key ?? ""} (${o.role ?? ""}) via ${o.tool ?? ""}${o.strategy ? `, ${o.strategy}` : ""}`;
  if (kind === "lead_decision") return [o.tool, o.action, o.decision, o.result].filter(Boolean).join(" · ");
  if (kind === "steer") return `steer: ${o.result ?? ""}`;
  if (kind === "items_added") return `added ${(o.added as string[] | undefined)?.join(", ") ?? ""}`;
  return JSON.stringify(o);
}
