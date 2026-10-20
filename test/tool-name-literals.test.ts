import { expect, test } from "bun:test";
import { join } from "node:path";
import * as sdkNames from "../src/tools/sdk-tool-names";

// Every tool name in src/ must come from an exported constant. This scans src/ for quoted tool names
// (and any "mcp__" literal) outside the constants files. The name set is built from the constants, so
// it maintains itself: add a constant and the scan covers it.
// Limits (a lint-style guard, not a proof): it misses names inside `${}` templates, concatenation or
// `join`, unquoted object keys, `Read(...)` pattern strings and names split across lines; it can misfire
// on apostrophes pairing with a later quote or on prose strings equal to a tool name.

const SRC = join(import.meta.dir, "..", "src");

/** Files where the literals live: the SDK names, the MCP server names and each MCP tool's own leaf `constants.ts`. */
const CONSTANTS_FILES = [
  /^tools\/sdk-tool-names\.ts$/,
  /^mcp\/mcp-tool-names\.ts$/,
  /^mcp\/[^/]+\/tools\/[^/]+Tool\/constants\.ts$/,
];

/** Every tool name known to the constants (SDK built-ins + MCP tools). */
const NAMES = new Set<string>(Object.values(sdkNames));
/** Names of MCP tools: every string export of `src/mcp/<server>/tools/*Tool/constants.ts` (self-maintaining). */
for (const rel of new Bun.Glob("mcp/*/tools/*Tool/constants.ts").scanSync(SRC)) {
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
      // A DOM event name (`addEventListener("click", ...)` in the viewer's page scripts) is not a browser tool name.
      const code = line.replace(/addEventListener\((["'`])[a-z]+\1/g, "addEventListener(");
      const quoted = [...code.matchAll(/(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2]!);
      if (quoted.some((q) => NAMES.has(q)) || /["'`]mcp__/.test(line))
        hits.push(`src/${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(hits).toEqual([]);
});
