/** The `tools` entry that switches a whole MCP server on. */
export const serverRef = (server: string) => `mcp__${server}`;

/** The prefix of the entries that name one tool of a server. */
const toolPrefix = (server: string) => `mcp__${server}__`;

/** True for the entry of the whole server and for the entry of one of its tools. */
export const isServerEntry = (entry: string, server: string) =>
  entry === serverRef(server) || entry.startsWith(toolPrefix(server));

/** The entries without any entry of `server`. */
export const withoutServer = (entries: string[], server: string) =>
  entries.filter((e) => !isServerEntry(e, server));

/** The tools of `server` the entries allow: all of `all` for the whole-server entry, else the named ones. */
export function selectedTools(entries: string[], server: string, all: string[]): Set<string> {
  if (entries.includes(serverRef(server))) return new Set(all);
  const prefix = toolPrefix(server);
  return new Set(entries.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length)));
}

/**
 * The entries after the owner chose `chosen` of the server's `all` tools: every tool becomes the whole-server entry
 * (so tools the server adds later come along), some become one entry each, none removes the server.
 */
export function withSelectedTools(
  entries: string[],
  server: string,
  all: string[],
  chosen: Set<string>,
): string[] {
  const rest = withoutServer(entries, server);
  if (chosen.size === 0) return rest;
  if (all.every((t) => chosen.has(t))) return [...rest, serverRef(server)];
  return [...rest, ...all.filter((t) => chosen.has(t)).map((t) => `${toolPrefix(server)}${t}`)];
}
