import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNEL_NAME, workspacePaths } from "../src/config/workspace-paths";
import { createMemorySaveTool } from "../src/mcp/memory/tools/MemorySaveTool/memory-save-tool";
import { buildMemoryContext, readMemoryLayers } from "../src/memory/channel-memory";
import { classifyFile } from "../src/memory/index/memory-files";
import { parseId } from "../src/memory/index/memory-ids";
import { searchIndex } from "../src/memory/index/memory-search";
import { syncAll } from "../src/memory/index/memory-sync";
import type { MemoryToolContext } from "../src/memory/memory-tool-context";
import { buildPersonaContext, ensureHome } from "../src/memory/persona";
import { openDb } from "../src/storage/db";
import { channelLocations, channelOf } from "../src/workspaces/task-workspace";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { clearWorkspaces, makeEnv, outsideDir } from "./helpers";

const CH_ID = "33333333333333333";
const WS = "main";

/** A space `main` with location `api` and channels `finance` (task) and `chat-room` (chat, subset [api, nope]). */
function space() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const loc = outsideDir();
  mkdirSync(join(loc, ".git"), { recursive: true });
  const root = join(env.home, "workspaces", WS);
  mkdirSync(join(root, "locations", "api"), { recursive: true }); // memory dir of the location
  writeFileSync(
    join(root, "workspace.yaml"),
    `channels:
  - {id: "${CH_ID}", name: finance, mode: task}
  - {id: "44444444444444444", name: chat-room, mode: chat, locations: [api, nope]}
locations:
  - {name: api, path: ${loc}}
`,
  );
  const scan = loadWorkspaces(env.home);
  ensureHome(env.home, scan.workspaces);
  const ws = scan.workspaces[0]!;
  return { home: env.home, ws, paths: workspacePaths(env.home).workspace(WS) };
}

/** Write a memory file with one bullet under `## Facts`. */
const note = (file: string, text: string) => writeFileSync(file, `# m\n\n## Facts\n- ${text}\n`);

test("registry: channel locations subset keeps known names, unknown ignored; names validated", () => {
  const { ws } = space();
  expect(ws.channels).toEqual([CH_ID, "44444444444444444"]);
  expect(ws.channelDefs[1]?.locations).toEqual(["api"]);
  expect(CHANNEL_NAME.test("finance")).toBe(true);
  expect(CHANNEL_NAME.test("../x")).toBe(false);
});

test("registry: a duplicate channel name inside a space keeps the first", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const root = join(env.home, "workspaces", WS);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "workspace.yaml"),
    `channels:
  - {id: "${CH_ID}", name: same}
  - {id: "44444444444444444", name: same}
  - {id: "55555555555555555", name: other}
`,
  );
  expect(loadWorkspaces(env.home).workspaces[0]?.channels).toEqual([CH_ID, "55555555555555555"]);
});

test("registry: locations [] or only unknown names fail closed (no locations); absent = all", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const loc = outsideDir();
  mkdirSync(join(loc, ".git"), { recursive: true });
  const root = join(env.home, "workspaces", WS);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "workspace.yaml"),
    `channels:
  - {id: "${CH_ID}", name: a, locations: []}
  - {id: "44444444444444444", name: b, locations: [typo]}
  - {id: "55555555555555555", name: c}
locations:
  - {name: api, path: ${loc}}
`,
  );
  const w = loadWorkspaces(env.home).workspaces[0]!;
  const names = (id: string) => channelLocations(w, channelOf(w, id)!).map((l) => l.name);
  expect(names(CH_ID)).toEqual([]);
  expect(names("44444444444444444")).toEqual([]);
  expect(names("55555555555555555")).toEqual(["api"]);
});

test("ensureHome creates channel dirs + MEMORY.md for every channel, never overwrites", () => {
  const { home, ws, paths } = space();
  expect(existsSync(paths.channel("finance").memory)).toBe(true);
  expect(existsSync(paths.channel("chat-room").memory)).toBe(true);
  writeFileSync(paths.channel("finance").memory, "# mine\n");
  ensureHome(home, [ws]);
  expect(readFileSync(paths.channel("finance").memory, "utf8")).toBe("# mine\n");
});

test("memory layers: root then channel, both whole (no cut); other channel or none = no block", () => {
  const { home, paths } = space();
  note(workspacePaths(home).memory, "root fact");
  note(paths.channel("finance").memory, "channel fact");
  const out = buildMemoryContext(home, WS, "finance");
  const at = ["### root", "### channel finance"].map((h) => out.indexOf(h));
  expect(at.every((n) => n >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  // No channel (or another channel with no notes): the layer is absent.
  expect(buildMemoryContext(home, WS, undefined)).not.toContain("### channel");
  expect(readMemoryLayers(home, WS, "chat-room").channel).toBe("");
  // No cap: a channel file over 3000 chars is injected whole.
  const big = Array.from({ length: 400 }, (_, i) => `- fact number ${i} padding padding`).join(
    "\n",
  );
  writeFileSync(paths.channel("finance").memory, `# m\n\n## Facts\n${big}\n`);
  const l = readMemoryLayers(home, WS, "finance");
  expect(l.channel.length).toBeGreaterThan(3000);
  expect(l.channel).toContain("fact number 0 ");
  expect(l.channel).toContain("fact number 399 ");
});

test("persona: only the root file is read; space and channel persona files are ignored", () => {
  const { home, paths } = space();
  writeFileSync(workspacePaths(home).soul, "# Soul\n- root tone\n");
  writeFileSync(paths.soul, "# Soul\n- space tone\n");
  writeFileSync(paths.channel("finance").soul, "# Soul\n- channel tone\n");
  const text = buildPersonaContext(home).text;
  expect(text).toContain("root tone");
  expect(text).not.toContain("space tone");
  expect(text).not.toContain("channel tone");
});

test("MemorySave scope channel writes the run's channel file; no channel = error", async () => {
  const { home, paths } = space();
  const ctx: MemoryToolContext = {
    db: openDb(":memory:"),
    home,
    workspace: WS,
    channel: "finance",
    threadLabel: "thread x",
  };
  const call = async (c: MemoryToolContext) => {
    const r = await createMemorySaveTool(c).handler(
      { text: "pays on friday", scope: "channel" } as never,
      {},
    );
    return { text: (r.content[0] as { text: string }).text, isError: !!r.isError };
  };
  const ok = await call(ctx);
  expect(ok.isError).toBe(false);
  expect(readFileSync(paths.channel("finance").memory, "utf8")).toContain("pays on friday");
  const none = await call({ ...ctx, channel: undefined });
  expect(none.isError).toBe(true);
  expect(none.text).toContain("no channel");
});

test("index: channel MEMORY.md is source channel, searchable only from its own channel", () => {
  const { home, paths } = space();
  const f = paths.channel("finance").memory;
  note(f, "zebra invoices");
  expect(classifyFile(home, f)).toEqual({ workspace: WS, source: "channel", channel: "finance" });
  expect(classifyFile(home, paths.channel("finance").soul)).toBeNull();
  const db = openDb(":memory:");
  syncAll(db, home);
  const find = (channel?: string) =>
    searchIndex(db, WS, { query: "zebra", limit: 5, channel }).hits;
  expect(find("finance").map((h) => h.source)).toEqual(["channel"]);
  expect(find("chat-room")).toEqual([]);
  expect(find(undefined)).toEqual([]);
  const id = find("finance")[0]!.id;
  expect(id.startsWith("channel/finance#")).toBe(true);
  expect(parseId(id)).toMatchObject({ type: "file", source: "channel", channel: "finance" });
});
