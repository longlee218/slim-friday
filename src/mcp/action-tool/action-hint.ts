import { z } from "zod";
import type { AnyAction } from "./action-types";

/** Loose view of the JSON schema nodes we read (type, enum, array items, unions, object properties). */
interface Node {
  type?: string;
  enum?: unknown[];
  items?: Node;
  anyOf?: Node[];
  properties?: Record<string, Node>;
  required?: string[];
}

/** Compact type of one JSON schema node: `string`, `number[]`, `a|b`, `object`. */
function typeOf(n: Node): string {
  if (n.enum) return n.enum.map(String).join("|");
  if (n.anyOf) return n.anyOf.map(typeOf).join("|");
  if (n.type === "array") {
    const inner = typeOf(n.items ?? {});
    return inner.includes("|") ? `(${inner})[]` : `${inner}[]`;
  }
  return n.type ?? "any";
}

/**
 * The params of an action as `name:type` pairs, optional ones as `name?:type`. Read from the action's own schema,
 * so the hint can never drift from what the handler checks.
 */
export function paramHint(action: AnyAction<unknown>): string {
  const json = z.toJSONSchema(action.schema, { io: "input" }) as Node;
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {})
    .map(([k, v]) => `${k}${required.has(k) ? "" : "?"}:${typeOf(v)}`)
    .join(", ");
}

/** The tool description: the intro, then one line per action (`name: params`), no prose. */
export function describeActions(intro: string, actions: readonly AnyAction<unknown>[]): string {
  return [intro, ...actions.map((a) => `- ${a.name}: ${paramHint(a) || "(no params)"}`)].join("\n");
}
