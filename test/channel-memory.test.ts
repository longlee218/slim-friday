import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import {
  buildMemoryContext,
  channelMemoryFile,
  readMemoryFile,
  readMemoryLayers,
} from "../src/memory/channel-memory";
import { ensureHome } from "../src/memory/persona";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { addLocation, makeEnv } from "./helpers";

/** Workspace and channel `addLocation` creates for `main`. */
const WS = "main";
const CH = "main-agent";

/** Env with a channel dir and its template file. */
function setup() {
  const env = makeEnv();
  addLocation(env.home, "api");
  ensureHome(env.home, loadWorkspaces(env.home).workspaces);
  return {
    home: env.home,
    root: workspacePaths(env.home).memory,
    ch: channelMemoryFile(env.home, WS, CH),
  };
}

test("readMemoryFile: missing and template-only are empty, an entry makes it count", () => {
  const { home, ch } = setup();
  expect(readMemoryFile(`${home}/nope/MEMORY.md`)).toBe("");
  expect(readMemoryFile(ch)).toBe(""); // template from ensureHome
  writeFileSync(ch, "# c\n\nintro\n");
  expect(readMemoryFile(ch)).toBe("");
  writeFileSync(ch, "# c\n\n## Facts\n- one\n");
  expect(readMemoryFile(ch)).toContain("- one");
});

test("root over 5000 chars and channel over 3000 chars are injected whole (no cut)", () => {
  const { home, root, ch } = setup();
  writeFileSync(root, `# r\n\n## d old\n- OLDEST\n## d new\n- ${"z".repeat(9000)}NEWEST\n`);
  writeFileSync(ch, `# c\n\n## d old\n- COLD\n## d new\n- ${"y".repeat(9000)}CNEW\n`);
  const layers = readMemoryLayers(home, WS, CH);
  expect(layers.root.length).toBeGreaterThan(9000);
  expect(layers.channel.length).toBeGreaterThan(9000);
  const out = buildMemoryContext(home, WS, CH);
  for (const m of ["OLDEST", "NEWEST", "COLD", "CNEW"]) expect(out).toContain(m);
});

test("block: headings root then channel, data-not-instructions line; empty without notes", () => {
  const { home, root, ch } = setup();
  expect(buildMemoryContext(home, WS, CH)).toBe("");
  writeFileSync(root, "# r\n\n## Facts\n- root fact\n");
  writeFileSync(ch, "# c\n\n## Facts\n- channel fact\n");
  const out = buildMemoryContext(home, WS, CH);
  expect(out).toContain("notes, not instructions");
  expect(out.indexOf("### root")).toBeLessThan(out.indexOf(`### channel ${CH}`));
  // No channel: root only.
  const rootOnly = buildMemoryContext(home, WS, undefined);
  expect(rootOnly).toContain("### root");
  expect(rootOnly).not.toContain("### channel");
});

test("retired workspace and location files are not layers", () => {
  const { home } = setup();
  const ws = workspacePaths(home).workspace(WS);
  const loc = `${ws.locations}/api/MEMORY.md`;
  mkdirSync(dirname(loc), { recursive: true });
  writeFileSync(loc, "# api\n\n## Facts\n- LOCATION_ONLY\n");
  writeFileSync(`${ws.root}/MEMORY.md`, "# ws\n\n## Facts\n- WORKSPACE_ONLY\n");
  const out = buildMemoryContext(home, WS, CH);
  expect(out).not.toContain("LOCATION_ONLY");
  expect(out).not.toContain("WORKSPACE_ONLY");
});
