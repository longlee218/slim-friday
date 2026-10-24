/** JSON with object keys sorted at every level, so equal inputs give equal text whatever their key order. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * The hash that names one exact tool call: sha256 (hex) of the tool name and its input as stable JSON. An
 * approval allows the call with this hash once. Async because it uses the standard Web Crypto digest.
 */
export async function inputHash(tool: string, input: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(`${tool}\n${stableJson(input)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
