/** MCP tool names read better without the server prefix: mcp__orchestration__Report -> Report. */
export function toolName(t: string): string {
  return t.startsWith("mcp__") ? t.split("__").slice(2).join("__") : t;
}

/** One-line hint of a step's input: the command, path, query or action it ran. */
export function inputHint(json: string): string {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const v = o.command ?? o.file_path ?? o.pattern ?? o.query ?? o.url ?? o.action ?? o.skill ?? o.description;
    return typeof v === "string" ? v : JSON.stringify(o).slice(0, 160);
  } catch {
    return json.slice(0, 160);
  }
}
