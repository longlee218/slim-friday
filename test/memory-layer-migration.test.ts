import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { loadBootState } from "../src/lifecycle/boot-checks";
import {
  LAYERS_V2_STEP,
  migrateMemoryLayers,
  parseLegacy,
} from "../src/memory/memory-layer-migration";
import { markerFile, readMarker } from "../src/memory/memory-migration-marker";
import { ensureHome } from "../src/memory/persona";
import { captureLogs, logger } from "../src/observability/logger";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { clearWorkspaces, makeEnv, outsideDir } from "./helpers";
import { STRAY_QUEUE_FILE } from "./memory-fixture";

const WS = "main";

/** Write a file (parents created) and return its path. */
function put(file: string, text: string): string {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/**
 * Home with space `main` (locations api, web; channels `finance` = all locations, `chat-room` = [api]) and
 * space `solo` (no channel), each with legacy workspace/location memory files, a stray pending file, and
 * `finance` already holding one of the notes.
 */
function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const [api, web] = [outsideDir(), outsideDir()];
  for (const d of [api, web]) mkdirSync(join(d, ".git"), { recursive: true });
  const root = join(env.home, "workspaces", WS);
  put(
    join(root, "workspace.yaml"),
    `channels:
  - {id: "33333333333333333", name: finance, mode: task}
  - {id: "44444444444444444", name: chat-room, mode: chat, locations: [api]}
locations:
  - {name: api, path: ${api}}
  - {name: web, path: ${web}}
`,
  );
  put(join(env.home, "workspaces", "solo", "workspace.yaml"), "channels: []\n");
  const scan = loadWorkspaces(env.home);
  ensureHome(env.home, scan.workspaces);
  const ws = workspacePaths(env.home).workspace(WS);
  const legacy = {
    workspace: put(
      join(root, "MEMORY.md"),
      "# main workspace memory\n\nintro line\n\n## Facts\n- ws fact (2026-09-01)\n- shared note (2026-09-02)\n\n## Decisions\n- ws undated decision\n\n## My topic\nowner prose line\n- owner bullet\n",
    ),
    api: put(
      join(ws.locations, "api", "MEMORY.md"),
      "# api memory\n\n## Facts\n- api fact (2026-09-05)\n- Shared note! (2026-09-09)\n\n## 2026-01-01 old\n- legacy bullet\n",
    ),
    web: put(
      join(ws.locations, "web", "MEMORY.md"),
      "# web\n\n## Lessons\n- web lesson (2026-09-07)\n",
    ),
    template: put(join(ws.locations, "tpl", "MEMORY.md"), "# tpl memory\n\nonly a header\n"),
    gone: put(join(ws.locations, "gone", "MEMORY.md"), "# gone\n\n## Facts\n- gone fact\n"),
    pending: put(join(env.home, STRAY_QUEUE_FILE), "# pending\n\n## Facts\n- pending fact\n"),
    solo: put(
      join(env.home, "workspaces", "solo", "MEMORY.md"),
      "# solo\n\n## Facts\n- solo fact (2026-09-03)\n",
    ),
  };
  // The channel already holds the shared note (other date): it must not be duplicated.
  put(
    ws.channel("finance").memory,
    "# finance channel memory\n\n## Facts\n- shared note (2026-10-01)\n",
  );
  const bytes = () => Object.values(legacy).map((f) => readFileSync(f).toString("base64"));
  return { env, scan, ws, legacy, bytes, home: env.home };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

test("parseLegacy: kind bullets keep their line, other sections are verbatim blocks, template gives null", () => {
  const p = parseLegacy(
    "# h\n\nintro\n\n## Facts\n- a (2026-01-01)\n- b\nloose prose\n\n## Topic\n\ntext\n- x\n",
  )!;
  expect(p.bullets).toEqual([
    { kind: "fact", line: "- a (2026-01-01)" },
    { kind: "fact", line: "- b" },
  ]);
  expect(p.blocks).toEqual(["## Facts (prose)\nloose prose", "## Topic\n\ntext\n- x"]);
  expect(parseLegacy("# t\n\nonly intro\n")).toBeNull();
});

test("merge: workspace -> every channel, location -> channels that include it; dates kept; duplicates skipped", () => {
  const s = setup();
  const r = migrateMemoryLayers(s.home, s.scan.workspaces);
  const fin = readFileSync(s.ws.channel("finance").memory, "utf8");
  const chat = readFileSync(s.ws.channel("chat-room").memory, "utf8");
  // finance: workspace + api + web notes; original lines (date or none) kept.
  for (const l of [
    "- ws fact (2026-09-01)",
    "- ws undated decision",
    "- api fact (2026-09-05)",
    "- web lesson (2026-09-07)",
  ])
    expect(fin).toContain(l);
  expect(fin).toContain("## Decisions\n- ws undated decision");
  expect(fin).toContain("## Lessons\n- web lesson (2026-09-07)");
  // The shared note exists once, with the date it already had.
  expect(count(fin.toLowerCase(), "shared note")).toBe(1);
  expect(fin).toContain("- shared note (2026-10-01)");
  // chat-room (locations [api]): workspace + api, not web.
  expect(chat).toContain("- ws fact (2026-09-01)");
  expect(chat).toContain("- api fact (2026-09-05)");
  expect(chat).not.toContain("web lesson");
  // Non-kind content moves verbatim under a heading dreaming never touches.
  expect(fin).toContain("## From workspace memory");
  expect(fin).toContain("## My topic\nowner prose line\n- owner bullet");
  expect(fin).toContain("## From location api memory");
  expect(fin).toContain("## 2026-01-01 old\n- legacy bullet");
  // Template-only location, orphan location and orphan space are not merged.
  expect(fin).not.toContain("only a header");
  expect(fin + chat).not.toContain("gone fact");
  expect(fin + chat).not.toContain("solo fact");
  expect(fin + chat).not.toContain("pending fact");
  expect(r).toMatchObject({ channels: 2, orphans: 2, failed: 0 });
  expect(r.bullets).toBeGreaterThan(0);
  expect(r.sections).toBeGreaterThan(0);
});

test("old files stay byte-identical, the marker is written, a rerun is a no-op and a forced rerun changes nothing", () => {
  const s = setup();
  const before = s.bytes();
  migrateMemoryLayers(s.home, s.scan.workspaces);
  expect(s.bytes()).toEqual(before);
  expect(Object.keys(readMarker(s.home))).toEqual([LAYERS_V2_STEP]);
  const after = [s.ws.channel("finance").memory, s.ws.channel("chat-room").memory].map((f) =>
    readFileSync(f, "utf8"),
  );
  // Marker present: nothing runs.
  expect(migrateMemoryLayers(s.home, s.scan.workspaces)).toEqual({
    channels: 0,
    bullets: 0,
    sections: 0,
    orphans: 0,
    failed: 0,
  });
  // Marker gone (a crash before it was written): dedupe makes the second pass write nothing new.
  writeFileSync(markerFile(s.home), "{}");
  const again = migrateMemoryLayers(s.home, s.scan.workspaces);
  expect(again).toMatchObject({ bullets: 0, sections: 0 });
  expect(
    [s.ws.channel("finance").memory, s.ws.channel("chat-room").memory].map((f) =>
      readFileSync(f, "utf8"),
    ),
  ).toEqual(after);
  expect(s.bytes()).toEqual(before);
  expect(Object.keys(readMarker(s.home))).toEqual([LAYERS_V2_STEP]);
});

test("log: counts only, never note text; orphans are counted", () => {
  const s = setup();
  const logs = captureLogs();
  migrateMemoryLayers(s.home, s.scan.workspaces);
  logs.stop();
  const ev = logs.lines.find((l) => l.event === "memory.migrate");
  expect(ev).toMatchObject({ step: LAYERS_V2_STEP, channels: 2, orphans: 2, failed: 0 });
  expect(typeof ev?.bullets).toBe("number");
  expect(typeof ev?.sections).toBe("number");
  const all = JSON.stringify(logs.lines);
  for (const text of ["ws fact", "api fact", "owner prose", "web lesson"])
    expect(all).not.toContain(text);
});

test("a symlinked channel file is refused: counted as failed, marker NOT written, nothing written through the link", () => {
  const s = setup();
  const out = join(s.home, "outside.md");
  writeFileSync(out, "# outside\n");
  const f = s.ws.channel("chat-room").memory;
  Bun.spawnSync(["rm", "-f", f]);
  symlinkSync(out, f);
  const r = migrateMemoryLayers(s.home, s.scan.workspaces);
  expect(r.failed).toBeGreaterThan(0);
  expect(readFileSync(out, "utf8")).toBe("# outside\n");
  expect(existsSync(markerFile(s.home))).toBe(false);
  // The healthy channel was still merged.
  expect(readFileSync(s.ws.channel("finance").memory, "utf8")).toContain("- ws fact (2026-09-01)");
});

test("a home with no legacy files: nothing merged, marker written", () => {
  const env = makeEnv();
  const scan = loadWorkspaces(env.home);
  ensureHome(env.home, scan.workspaces);
  const r = migrateMemoryLayers(env.home, scan.workspaces);
  expect(r).toMatchObject({ channels: 0, bullets: 0, sections: 0, orphans: 0, failed: 0 });
  expect(Object.keys(readMarker(env.home))).toEqual([LAYERS_V2_STEP]);
});

test("start-up (loadBootState) runs the migration after ensureHome and writes the marker", () => {
  const s = setup();
  const keys = [
    "AGENT_HOME",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "DISCORD_TOKEN",
    "OWNER_DISCORD_ID",
    "DISCORD_GUILD_ID",
  ] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    AGENT_HOME: s.home,
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test-token",
    DISCORD_TOKEN: "test-discord-token",
    OWNER_DISCORD_ID: "123456789012345678",
    DISCORD_GUILD_ID: "111111111111111111",
  });
  try {
    loadBootState(logger);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  expect(Object.keys(readMarker(s.home))).toEqual([LAYERS_V2_STEP]);
  expect(readFileSync(s.ws.channel("finance").memory, "utf8")).toContain("- ws fact (2026-09-01)");
});

test("a space with legacy content but no loaded workspace entry counts as failed: marker NOT written", () => {
  const s = setup();
  // Space `ghost` is on disk with memory content but has no workspace.yaml entry in the loaded list.
  put(
    join(s.home, "workspaces", "ghost", "MEMORY.md"),
    "# ghost\n\n## Facts\n- ghost fact (2026-09-03)\n",
  );
  const r = migrateMemoryLayers(s.home, s.scan.workspaces);
  expect(r.failed).toBeGreaterThan(0);
  expect(existsSync(markerFile(s.home))).toBe(false);
});

test("a missing channel dir is created; the migration is not aborted", () => {
  const s = setup();
  rmSync(join(s.ws.channel("chat-room").memory, ".."), { recursive: true, force: true });
  const r = migrateMemoryLayers(s.home, s.scan.workspaces);
  expect(r.failed).toBe(0);
  expect(readFileSync(s.ws.channel("chat-room").memory, "utf8")).toContain(
    "- ws fact (2026-09-01)",
  );
  expect(readFileSync(s.ws.channel("finance").memory, "utf8")).toContain("- ws fact (2026-09-01)");
  expect(existsSync(markerFile(s.home))).toBe(true);
});
