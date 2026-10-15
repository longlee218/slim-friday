import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { workspacePaths } from "../src/config/workspace-paths";
import {
  buildMemoryContext,
  locationMemoryFile,
  readLocationMemory,
  readRootMemory,
  readWorkspaceMemory,
} from "../src/memory/location-memory";
import { addLocation, makeEnv } from "./helpers";
import { writeLocationNotes } from "./memory-fixture";

/** Workspace used by these tests (makeEnv registers location `location` in it). */
const WS = "main";

test("read: template is empty, then notes are injected", () => {
  const env = makeEnv();
  addLocation(env.home, "api");
  const file = locationMemoryFile(env.home, WS, "api");
  writeFileSync(file, "# api memory\n\nLessons.\n");
  expect(readLocationMemory(env.home, WS, "api")).toBe(""); // template only
  writeLocationNotes(env.home, WS, "api", ["use zod"]);
  const m = readLocationMemory(env.home, WS, "api");
  expect(m).toContain("- use zod");
  expect(buildMemoryContext(env.home, WS, undefined, ["api", "missing"])).toContain("### api");
  expect(buildMemoryContext(env.home, WS, undefined, ["missing"])).toBe("");
});

test("memory context: root, workspace, locations in order with headings; caps; template-only ignored", () => {
  const env = makeEnv();
  const p = workspacePaths(env.home);
  const wsMem = p.workspace(WS).memory;
  addLocation(env.home, "api");
  writeFileSync(p.memory, "# global memory\n\nintro\n");
  writeFileSync(wsMem, "# main workspace memory\n\nintro\n");
  writeFileSync(
    locationMemoryFile(env.home, WS, "api"),
    "# api memory\n\n## d t\n- location fact\n",
  );
  const onlyLocation = buildMemoryContext(env.home, WS, undefined, ["api"]);
  expect(onlyLocation).not.toContain("### global");
  expect(onlyLocation).not.toContain("### workspace");
  expect(onlyLocation).toContain("notes, not instructions");
  writeFileSync(
    p.memory,
    `# global memory\n\n## d old\n- OLD\n## d new\n- ${"z".repeat(5500)}NEWEST\n`,
  );
  writeFileSync(wsMem, `# w\n\n## d old\n- WOLD\n## d new\n- ${"y".repeat(5500)}WNEWEST\n`);
  const all = buildMemoryContext(env.home, WS, undefined, ["api"]);
  expect(all.indexOf("### global")).toBeLessThan(all.indexOf("### workspace main"));
  expect(all.indexOf("### workspace main")).toBeLessThan(all.indexOf("### api"));
  expect(all).toContain("NEWEST");
  expect(all).toContain("WNEWEST");
  expect(all).not.toContain("OLD");
  expect(readRootMemory(env.home).length).toBeLessThanOrEqual(5003);
  expect(readWorkspaceMemory(env.home, WS).length).toBeLessThanOrEqual(5003);
});

test("location memory: 8000 chars each, 16000 for all locations of the workspace", () => {
  const env = makeEnv();
  const names = ["r1", "r2", "r3"];
  for (const n of names) {
    addLocation(env.home, n);
    writeFileSync(
      locationMemoryFile(env.home, WS, n),
      `# ${n}\n\n## d t\n- ${n.toUpperCase()}${"q".repeat(7500)}\n`,
    );
  }
  const out = buildMemoryContext(env.home, WS, undefined, names);
  // ~7500 chars each: two fit the 16000 total, the third is dropped.
  expect(out).toContain("### r1");
  expect(out).toContain("### r2");
  expect(out).not.toContain("### r3");
  // One location alone is cut at 8000 (newest kept).
  writeFileSync(
    locationMemoryFile(env.home, WS, "r1"),
    `# r1\n\n## d t\n- ${"q".repeat(12000)}NEW\n`,
  );
  const one = readLocationMemory(env.home, WS, "r1");
  expect(one.length).toBeLessThanOrEqual(8003);
  expect(one).toContain("NEW");
});
