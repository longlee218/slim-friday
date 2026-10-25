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

test("a user bot with the reserved id owner is refused", () => {
  const dirs = mkdtempSync(join(tmpdir(), "reserved-owner-"));
  mkdirSync(join(dirs, "user", "bots"), { recursive: true });
  mkdirSync(join(dirs, "defaults"), { recursive: true });
  writeFileSync(
    join(dirs, "user", "bots", "owner.md"),
    "---\nname: O\ntitle: T\nmodel: m\n---\nHi.\n",
  );
  const { snapshot, problems } = loadConfig({
    defaultsDir: join(dirs, "defaults"),
    userDir: join(dirs, "user"),
  });
  expect(snapshot.bots.has("owner")).toBe(false);
  expect(problems.some((p) => p.message.includes("reserved"))).toBe(true);
});

test("an empty user dir gives the shipped defaults and no problems", () => {
  const { snapshot, problems } = load(userDir());
  expect(problems).toEqual([]);
  expect([...snapshot.bots.keys()]).toEqual(["friday"]);
  expect(snapshot.tools).toHaveLength(51);
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
  expect([...snapshot.bots.keys()]).toEqual(["friday", "good"]);
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
  expect(snapshot.tools).toHaveLength(52);
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

test("files with the wrong extension are reported, dotfiles are not", () => {
  const user = userDir({
    "bots/x.yaml": bot("X"),
    "bots/.hidden.md": "junk",
    "groups/team.yml": "name: T\nmembers: [x]\nentryBot: x\n",
    "settings.yml": "autonomy:\n  level: careful\n",
    "tools.yml": "tools: []\n",
  });
  const { problems } = load(user);
  expect(problems.map((p) => p.file).sort()).toEqual(
    ["bots/x.yaml", "groups/team.yml", "settings.yml", "tools.yml"]
      .map((f) => join(user, f))
      .sort(),
  );
});

test("a bots dir that is a file is a problem, not a crash", () => {
  const user = userDir({ bots: "not a dir" });
  expect(load(user).problems).toHaveLength(1);
});

test("autonomy.bots naming a bot that does not exist is reported", () => {
  const user = userDir({
    "bots/ann.md": bot("Ann"),
    "settings.yaml": "autonomy:\n  bots: {reviewr: careful, ann: careful}\n",
  });
  const { problems } = load(user);
  expect(problems).toHaveLength(1);
  expect(problems[0]?.file).toBe(join(user, "settings.yaml"));
  expect(problems[0]?.message).toContain("reviewr");
});

test("limits must be usable: counts are integers, timers fit a 32-bit timer", () => {
  for (const bad of [
    "groupContextMessages: 2.5",
    "maxHops: 1.5",
    "repeatWindowMs: 3000000000",
    "idleCloseMs: 3000000000",
  ]) {
    const { snapshot, problems } = load(userDir({ "settings.yaml": `limits:\n  ${bad}\n` }));
    expect(problems).toHaveLength(1);
    expect(snapshot.limits).toEqual(CORE_DEFAULTS);
  }
  const ok = load(userDir({ "settings.yaml": "limits:\n  maxSpendPerBotPerDayUsd: 2.5\n" }));
  expect(ok.problems).toEqual([]);
});

test("the retired approvalTimeoutMs limit is ignored, not a load problem", () => {
  const { snapshot, problems } = load(
    userDir({ "settings.yaml": "limits:\n  approvalTimeoutMs: 600000\n  maxHops: 3\n" }),
  );
  expect(problems).toEqual([]);
  expect(snapshot.limits.maxHops as number).toBe(3);
  expect(snapshot.limits.idleCloseMs).toBe(CORE_DEFAULTS.idleCloseMs);
  expect("approvalTimeoutMs" in snapshot.limits).toBe(false);
});

test("SOUL.md and USER.md go before every bot's instructions; the user dir wins over the shipped SOUL", () => {
  const dir = userDir({
    "bots/ann.md": bot("Ann", "Ann rules."),
    "SOUL.md": "Answer in one line.",
    "USER.md": "Long, backend engineer.",
  });
  const { snapshot } = load(dir);
  const text = snapshot.bots.get("ann")?.instructions ?? "";
  expect(text).toBe("Answer in one line.\n\n## The owner\nLong, backend engineer.\n\nAnn rules.");
  expect(snapshot.bots.get("friday")?.instructions.startsWith("Answer in one line.")).toBe(true);
});

test("the shipped SOUL applies when the user has none, and an absent USER.md adds nothing", () => {
  const { snapshot, problems } = load(userDir({ "bots/ann.md": bot("Ann", "Ann rules.") }));
  expect(problems).toEqual([]);
  const text = snapshot.bots.get("ann")?.instructions ?? "";
  expect(text.endsWith("\n\nAnn rules.")).toBe(true);
  expect(text.length).toBeGreaterThan("Ann rules.".length + 20);
  expect(text).not.toContain("The owner");
});

test("the BotDesign card shows what will be written: its scope keys carry the risky fields", () => {
  const { snapshot } = load(userDir());
  const spec = snapshot.tools.find((t) => t.name === "mcp__design__BotDesign");
  for (const k of ["action", "id", "overwrite", "autonomy", "server", "tools", "workspaces"])
    expect(spec?.scopeKeys).toContain(k);
});
