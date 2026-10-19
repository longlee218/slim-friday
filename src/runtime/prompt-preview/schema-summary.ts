/** A JSON schema node (the subset zod emits). */
type Node = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  properties?: Record<string, Node>;
  required?: string[];
  items?: Node;
  oneOf?: Node[];
  anyOf?: Node[];
};

/** Short type text of a node: `string`, `"a"|"b"`, `string[]`, `object`. */
function typeOf(n: Node): string {
  if (n.const !== undefined) return JSON.stringify(n.const);
  if (n.enum) return n.enum.map((e) => JSON.stringify(e)).join("|");
  const variants = n.oneOf ?? n.anyOf;
  if (variants) return variants.map(typeOf).join(" | ");
  if (n.type === "array") return `${n.items ? typeOf(n.items) : "any"}[]`;
  return Array.isArray(n.type) ? n.type.join("|") : (n.type ?? "any");
}

/** One line per property of an object node: `name[?]: type - description`. */
function propLines(n: Node, indent: string): string[] {
  return Object.entries(n.properties ?? {}).map(([k, v]) => {
    const opt = n.required?.includes(k) ? "" : "?";
    return `${indent}- ${k}${opt}: ${typeOf(v)}${v.description ? ` - ${v.description}` : ""}`;
  });
}

/**
 * Readable summary of a tool's input schema. An object lists its params; a union (the action tools) lists one block per
 * variant, headed by the variant's `action` const when it has one.
 */
export function summarizeSchema(schema: unknown): string[] {
  const n = schema as Node;
  const variants = n.oneOf ?? n.anyOf;
  if (!variants) return propLines(n, "");
  return variants.flatMap((v) => {
    const action = v.properties?.action?.const;
    const head = action !== undefined ? `- action ${JSON.stringify(action)}:` : "- variant:";
    return [head, ...propLines(v, "  ").filter((l) => !l.includes("- action"))];
  });
}
