import { expect, test } from "bun:test";
import { dirname, relative, resolve } from "node:path";
import { Glob } from "bun";
import { ALL_SERVERS, EXTERNAL_SERVERS } from "../src/mcp/manifests";
import { mcpToolNamesFor } from "../src/mcp/mcp-servers";
import { MCP_TOOL_SERVER, mcpToolNamesOfRole } from "../src/mcp/tool-names-of-role";
import { ROLES } from "../src/roles/role-registry";

/** Every `src` file outside the tool adapters (`src/mcp`) and the SDK tool-name table (`src/tools`): tools call into these, never the reverse. */
const SCANNED = new Glob("src/**/*.ts");
const isLayerFile = (f: string) => !f.startsWith("src/mcp/") && !f.startsWith("src/tools/");

/** Allowed imports of `src/mcp` (always allowed: `constants.ts`, `action-names.ts`, `mcp-tool-names.ts`, the artifacts and
    servers' name lists `artifact-tool-names.ts` (import only constants),
    `import type` of manifest-types). */
const ALLOWED_IMPORT =
  /(^|\/)(constants|mcp-tool-names|action-names|artifact-tool-names)$|^src\/mcp\/manifest-types$/;

/** Extra exceptions: `file -> imported module`, each with the reason. Keep it as short as possible. */
const ALLOW_LIST: Record<string, string> = {
  // The SDK options builder is the one place that builds the per-run MCP servers.
  "src/runtime/sdk-options.ts -> src/mcp/mcp-servers": "builds the run's MCP servers",
  // Offline prompt viewer (`bun run prompt:show`): lists the tool definitions the run's servers carry.
  "src/runtime/prompt-preview/tool-definitions.ts -> src/mcp/mcp-servers": "prompt viewer",
  // Leaf data of tool names (imports only constants), used by the guard.
  "src/policy/check-tool-call.ts -> src/mcp/tool-names-of-role": "leaf: names only",
};

/** `from "<spec>"` of every static import/export in a source text (multi-line imports included). */
const FROM_RE =
  /(?:import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"|(?:import|require)\(\s*"([^"]+)"|import\s+"([^"]+)"/g;

test("src layers import src/mcp only through constants, tool names and manifest types", () => {
  const violations: string[] = [];
  for (const file of [...SCANNED.scanSync(".")].filter(isLayerFile)) {
    const text = require("node:fs").readFileSync(file, "utf8") as string;
    for (const m of text.matchAll(FROM_RE)) {
      const spec = m[2] ?? m[3] ?? m[4] ?? "";
      if (!spec.startsWith(".")) continue;
      const target = relative(".", resolve(dirname(file), spec));
      if (!target.startsWith("src/mcp/") && target !== "src/mcp") continue;
      if (ALLOWED_IMPORT.test(target) && (target !== "src/mcp/manifest-types" || m[1])) continue;
      if (ALLOW_LIST[`${file} -> ${target}`]) continue;
      violations.push(`${file} -> ${target}`);
    }
  }
  expect(violations).toEqual([]);
});

test("the guard's leaf tool-name table matches the server manifests", () => {
  const fromManifests = Object.fromEntries([
    ...ALL_SERVERS.flatMap((m) => m.tools.map((t) => [t.name, m.name])),
    ...EXTERNAL_SERVERS.flatMap((m) => m.tools.map((t) => [t, m.name])),
  ]);
  expect(MCP_TOOL_SERVER).toEqual(fromManifests);
  // A bare name in two servers would collapse in the table above.
  const names = ALL_SERVERS.flatMap((m) => m.tools.map((t) => t.name));
  expect(new Set(names).size).toBe(names.length);
  for (const role of Object.values(ROLES))
    expect(new Set(mcpToolNamesOfRole(role))).toEqual(new Set(mcpToolNamesFor(role)));
});
