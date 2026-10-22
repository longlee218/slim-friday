import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* Chat providers (Discord today, Telegram or Slack later) live in src/providers/<name>/. Nothing else imports a chat SDK,
   and the core never imports a provider: src/index.ts (the composition root) wires a provider in. */

/** Every .ts file under `dir`. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Module specifiers a source imports or re-exports (static and dynamic). */
function specifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string);
}

const SDKS = ["discord.js"];
const files = [...tsFiles("src"), ...tsFiles("scripts")];
const inProvider = (f: string) => f.startsWith(join("src", "providers") + "/");

test("a chat SDK is imported only inside src/providers (and src/index.ts, the composition root)", () => {
  const bad = files
    .filter((f) => !inProvider(f) && f !== join("src", "index.ts"))
    .filter((f) => specifiers(f).some((s) => SDKS.includes(s)));
  expect(bad).toEqual([]);
});

/** Known debt: the Discord admin MCP server, the boot checks of the Discord setup and channel adoption still import
   provider modules. The list can only shrink (a stale entry fails the second test), never grow. */
const DEBT = [
  "src/lifecycle/boot-checks.ts",
  "src/mcp/manifest-types.ts",
  "src/mcp/discord-admin/tools/CreateSpaceOrChannelTool/create-space-or-channel-tool.ts",
  "src/mcp/discord-admin/tools/WriteSpaceFileTool/write-space-file-tool.ts",
  "src/mcp/discord-admin/tools/ListSpacesTool/list-spaces-tool.ts",
  "src/workspaces/adopt-channel.ts",
];

const importsProvider = files
  .filter((f) => !inProvider(f) && f !== join("src", "index.ts"))
  .filter((f) => specifiers(f).some((s) => /(^|\/)providers\//.test(s)));

test("the core never imports a provider (src/index.ts wires it in), except the listed debt", () => {
  expect(importsProvider.filter((f) => !DEBT.includes(f))).toEqual([]);
});

test("the debt list has no stale entry: a file that no longer imports a provider is removed from it", () => {
  expect(DEBT.filter((f) => !importsProvider.includes(f))).toEqual([]);
});
