import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { createWorkspaceDir } from "../src/discord-setup/workspace-template";
import { listSpaces } from "../src/mcp/discord-admin/tools/ListSpacesTool/list-spaces-tool";
import { SPACE_KIND_FILES, spaceKindFile, spaceKinds } from "../src/memory/persona-templates";
import { assertTempHome } from "./helpers";

test("kinds are the folders of the templates dir", () => {
  expect(spaceKinds()).toEqual(["company", "personal", "study"]);
});

test("every kind ships the four persona files with real content (not a heading-only stub)", () => {
  for (const kind of spaceKinds())
    for (const file of SPACE_KIND_FILES) {
      const text = spaceKindFile(kind, file) ?? "";
      expect(text.split("\n").filter((l) => l.trim() && !l.startsWith("#")).length).toBeGreaterThan(
        1,
      );
    }
  expect(SPACE_KIND_FILES).toEqual(["USER.md", "IDENTITY.md", "AGENTS.md", "SOUL.md"]);
});

test("an unknown kind or file name (or a path) gives undefined, never a read", () => {
  expect(spaceKindFile("../space-kinds/study", "USER.md")).toBeUndefined();
  expect(spaceKindFile("nope", "USER.md")).toBeUndefined();
  expect(spaceKindFile("study", "../study/USER.md")).toBeUndefined();
  expect(spaceKindFile("study", "MEMORY.md")).toBeUndefined();
});

test("/init-workspace keeps its heading-only stubs (kinds are applied by the role, not by the command)", () => {
  const home = mkdtempSync(join(tmpdir(), "friday-kinds-"));
  assertTempHome(home);
  createWorkspaceDir(home, "demo");
  const soul = readFileSync(workspacePaths(home).workspace("demo").soul, "utf8");
  expect(soul).toContain("Optional override");
  expect(soul).not.toBe(spaceKindFile("study", "SOUL.md"));
});

test("ListSpaces lists spaces, kinds and the template text of a given kind", () => {
  const home = mkdtempSync(join(tmpdir(), "friday-kinds-"));
  assertTempHome(home);
  const none = JSON.parse(listSpaces(home));
  expect(none).toMatchObject({ spaces: [], kinds: ["company", "personal", "study"] });
  expect(none.template).toBeUndefined();
  const withKind = JSON.parse(listSpaces(home, "study"));
  expect(withKind.template["SOUL.md"]).toBe(spaceKindFile("study", "SOUL.md"));
  expect(JSON.parse(listSpaces(home, "nope")).template["SOUL.md"]).toBeUndefined();
});
