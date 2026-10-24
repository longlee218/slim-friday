import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SKILLS_DIR, DEFAULTS_DIR, loadConfig } from "../src/load-config";
import { loadTemplate } from "../src/templates";

const ALLOWED = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebSearch", "WebFetch"];

test("the shipped Friday bot designs through BotDesign: no file tools, its skills ship, every tool is in the catalog", () => {
  const userDir = mkdtempSync(join(tmpdir(), "cfg-"));
  const { snapshot, problems } = loadConfig({ defaultsDir: DEFAULTS_DIR, userDir });
  expect(problems).toEqual([]);
  const f = snapshot.bots.get("friday");
  expect(f?.name).toBe("Friday");
  const tools = f?.tools ?? [];
  for (const t of ["mcp__design__BotDesign", "mcp__design__BotLookup", "Bash", "WebFetch"])
    expect(tools).toContain(t);
  // The config dir is written only through BotDesign.
  for (const t of ["Read", "Write", "Edit", "NotebookEdit"]) expect(tools).not.toContain(t);
  const catalog = new Set(snapshot.tools.map((t) => t.name));
  expect(tools.filter((t) => !catalog.has(t))).toEqual([]);
  expect(f?.skills).toEqual(["bot-design", "skill-install", "skill-creator"]);
  for (const s of f?.skills ?? [])
    expect(existsSync(join(DEFAULT_SKILLS_DIR, s, "SKILL.md"))).toBe(true);
  expect(f?.workspaces).toEqual([]);
  expect(f?.instructions).toContain("<template dir>");
});

for (const [name, entry] of [
  ["code", "planner"],
  ["social-content", "strategist"],
  ["research", "lead"],
] as const) {
  test(`template ${name}: loads, entry bot is a member, members hand off with @Name`, () => {
    const { group, bots } = loadTemplate(name);
    expect(group.id).toBe(name);
    expect(group.entryBot).toBe(entry);
    expect(group.members.sort()).toEqual(bots.map((b) => b.id).sort());
    for (const b of bots) {
      const others = bots.filter((o) => o.id !== b.id);
      expect(others.some((o) => b.instructions.includes(`@${o.name}`))).toBe(true);
      for (const t of b.tools) expect(ALLOWED).toContain(t);
      expect(b.workspaces).toEqual([]);
    }
  });
}

test("a user bot file with the reserved id friday is reported and ignored", () => {
  const userDir = mkdtempSync(join(tmpdir(), "cfg-"));
  mkdirSync(join(userDir, "bots"));
  writeFileSync(
    join(userDir, "bots", "friday.md"),
    "---\nname: Friday\ntitle: x\nmodel: sonnet\ntools: [Bash]\n---\nown\n",
  );
  const { snapshot, problems } = loadConfig({ defaultsDir: DEFAULTS_DIR, userDir });
  const tools = snapshot.bots.get("friday")?.tools ?? [];
  expect(tools).toContain("mcp__design__BotDesign");
  expect(tools).toContain("mcp__effects__CreateProject");
  expect(problems.map((p) => p.message).join()).toContain("reserved");
});

test("Friday asks before it writes: shipped autonomy is careful", () => {
  const userDir = mkdtempSync(join(tmpdir(), "cfg-"));
  const { snapshot } = loadConfig({ defaultsDir: DEFAULTS_DIR, userDir });
  expect(snapshot.bots.get("friday")?.autonomy).toBe("careful");
});

test("a group that lists the Friday bot as a member is refused", () => {
  const userDir = mkdtempSync(join(tmpdir(), "cfg-"));
  mkdirSync(join(userDir, "bots"));
  mkdirSync(join(userDir, "groups"));
  writeFileSync(
    join(userDir, "bots", "ann.md"),
    "---\nname: Ann\ntitle: x\nmodel: sonnet\n---\nhi\n",
  );
  writeFileSync(
    join(userDir, "groups", "g.yaml"),
    "name: G\nmembers: [ann, friday]\nentryBot: ann\n",
  );
  const { snapshot, problems } = loadConfig({ defaultsDir: DEFAULTS_DIR, userDir });
  expect(snapshot.groups.has("g")).toBe(false);
  expect(problems.map((p) => p.message).join()).toContain("friday");
});

const header = (name: string, extra = "") =>
  `---\nname: ${name}\ntitle: T\nmodel: sonnet\n${extra}---\nbody\n`;

test("bot names Discord refuses for webhooks are refused; absolute workspaces are normalised", async () => {
  const { parseBotFile } = await import("../src/schemas/bot-file");
  expect(() => parseBotFile("a", header("Discord"))).toThrow();
  expect(() => parseBotFile("a", header("MyClydeBot"))).toThrow();
  expect(parseBotFile("a", header("Ann", "workspaces: [/x/y/../z]\n")).workspaces).toEqual([
    "/x/z",
  ]);
});
