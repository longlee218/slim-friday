import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_DEFAULTS } from "@friday/core";
import { DEFAULTS_DIR, loadConfig } from "../src/load-config";

/** A temp user dir with the given files (path relative to it → text). */
function userDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const bot = (name: string, body = "Be brief.", extra = "") =>
  `---\nname: ${name}\ntitle: T\nmodel: sonnet\n${extra}---\n${body}\n`;
const load = (dir: string, defaultsDir = DEFAULTS_DIR) => loadConfig({ defaultsDir, userDir: dir });

test("an empty user dir gives the shipped defaults and no problems", () => {
  const { snapshot, problems } = load(userDir());
  expect(problems).toEqual([]);
  expect(snapshot.bots.size).toBe(0);
  expect(snapshot.tools).toHaveLength(11);
  expect(snapshot.settings.level).toBe("balanced");
  expect(snapshot.limits).toEqual(CORE_DEFAULTS);
});

test("a missing user dir is fine", () => {
  expect(load(join(tmpdir(), "does-not-exist-xyz")).problems).toEqual([]);
});

test("a user bot replaces a default bot of the same id; a default group stays", () => {
  const defaults = userDir({
    "bots/ann.md": bot("Ann", "default"),
    "bots/bob.md": bot("Bob"),
    "groups/team.yaml": "name: Team\nmembers: [ann, bob]\nentryBot: ann\n",
  });
  const user = userDir({ "bots/ann.md": bot("Ann", "mine") });
  const { snapshot, problems } = load(user, defaults);
  expect(problems).toEqual([]);
  expect(snapshot.bots.get("ann")?.instructions).toBe("mine");
  expect(snapshot.bots.has("bob")).toBe(true);
  expect(snapshot.groups.has("team")).toBe(true);
});

test("bad files are skipped and each one is listed with its path", () => {
  const user = userDir({
    "bots/good.md": bot("Good"),
    "bots/badyaml.md": "---\nname: [\n---\nx\n",
    "bots/extra.md": bot("Extra", "x", "unknown: 1\n"),
    "bots/zdup.md": bot("GOOD"),
    "groups/g.yaml": "name: G\nmembers: [good, ghost]\nentryBot: good\n",
  });
  const { snapshot, problems } = load(user);
  expect([...snapshot.bots.keys()]).toEqual(["good"]);
  expect(snapshot.groups.size).toBe(0);
  expect(problems.map((p) => p.file).sort()).toEqual(
    ["bots/badyaml.md", "bots/extra.md", "bots/zdup.md", "groups/g.yaml"]
      .map((f) => join(user, f))
      .sort(),
  );
  for (const p of problems) expect(p.message.length).toBeGreaterThan(0);
});

test("user tools replace by name and new ones are appended", () => {
  const user = userDir({
    "tools.yaml":
      "tools:\n  - name: Bash\n    annotations: {destructiveHint: true}\n  - name: mcp__x__y\n    annotations: {readOnlyHint: true}\n",
  });
  const { snapshot } = load(user);
  expect(snapshot.tools.find((t) => t.name === "Bash")).toEqual({
    name: "Bash",
    annotations: { destructiveHint: true },
  });
  expect(snapshot.tools).toHaveLength(12);
  expect(snapshot.tools.at(-1)?.name).toBe("mcp__x__y");
});

test("user settings merge over the defaults; a bot's own autonomy wins", () => {
  const user = userDir({
    "settings.yaml":
      "autonomy:\n  bots: {ann: autonomous}\n  tools: {Bash: ask}\nlimits:\n  maxHops: 3\n",
    "bots/ann.md": bot("Ann", "x", "autonomy: careful\n"),
  });
  const { snapshot, problems } = load(user);
  expect(problems).toEqual([]);
  expect(snapshot.settings.level).toBe("balanced");
  expect(snapshot.settings.tools?.Bash).toBe("ask");
  expect(snapshot.settings.botLevels?.ann).toBe("careful");
  expect<number>(snapshot.limits.maxHops).toBe(3);
  expect(snapshot.limits.idleCloseMs).toBe(CORE_DEFAULTS.idleCloseMs);
});

test("a broken settings.yaml gives the defaults and one problem", () => {
  const user = userDir({ "settings.yaml": "limits:\n  maxHops: 0\n" });
  const { snapshot, problems } = load(user);
  expect(problems).toHaveLength(1);
  expect(snapshot.limits).toEqual(CORE_DEFAULTS);
  expect(snapshot.settings.level).toBe("balanced");
});
