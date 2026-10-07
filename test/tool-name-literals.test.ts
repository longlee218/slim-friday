import { expect, test } from "bun:test";
import { join } from "node:path";
import * as mcpNames from "../src/mcp/mcp-tool-names";
import * as sdkNames from "../src/tools/sdk-tool-names";

// Every tool name in src/ must come from an exported constant. This scans src/ for quoted tool names
// (and any "mcp__" literal) outside the constants files. The name set is built from the constants, so
// it maintains itself: add a constant and the scan covers it.
// Limits (a lint-style guard, not a proof): it misses names inside `${}` templates, concatenation or
// `join`, unquoted object keys, `Read(...)` pattern strings and names split across lines; it can misfire
// on apostrophes pairing with a later quote or on prose strings equal to a tool name.

const SRC = join(import.meta.dir, "..", "src");

/** Files where the literals live (the constants themselves). */
const CONSTANTS_FILES = [
  /^tools\/sdk-tool-names\.ts$/,
  /^mcp\/mcp-tool-names\.ts$/,
  /^tools\/[^/]+Tool\/constants\.ts$/,
];

/** Every tool name known to the constants (SDK built-ins, MCP servers + tools). */
const NAMES = new Set<string>([
  ...Object.values(sdkNames),
  ...Object.values(mcpNames.GIT_TOOL),
  ...Object.values(mcpNames.GITHUB_TOOL),
  mcpNames.GIT_MCP_SERVER,
  mcpNames.GITHUB_MCP_SERVER,
]);
/** Server names are generic words ("git" is also a shell command); only tool names + mcp__ are scanned. */
NAMES.delete(mcpNames.GIT_MCP_SERVER);
NAMES.delete(mcpNames.GITHUB_MCP_SERVER);

/** Names of custom tools: every string export of `src/tools/*Tool/constants.ts` (self-maintaining). */
for (const rel of new Bun.Glob("tools/*Tool/constants.ts").scanSync(SRC)) {
  const mod = (await import(join(SRC, rel))) as Record<string, unknown>;
  for (const v of Object.values(mod)) if (typeof v === "string") NAMES.add(v);
}

/** Comment lines are skipped (docs may name tools). */
const isComment = (line: string) => /^(\/\/|\*|\/\*)/.test(line.trim());

test("no tool-name literals in src/ outside the constants files", async () => {
  const hits: string[] = [];
  for await (const rel of new Bun.Glob("**/*.ts").scan(SRC)) {
    if (CONSTANTS_FILES.some((re) => re.test(rel))) continue;
    const lines = (await Bun.file(join(SRC, rel)).text()).split("\n");
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      const quoted = [...line.matchAll(/(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2]!);
      if (quoted.some((q) => NAMES.has(q)) || /["'`]mcp__/.test(line))
        hits.push(`src/${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(hits).toEqual([]);
});
