import { beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SkillAdmin } from "@friday/core";
import { createSkillAdmin } from "../../src/admin/skill-admin";
import { createBotDesignTool } from "../../src/design/tools/BotDesignTool/bot-design-tool";
import { call, putSkill, setup, textOf } from "../design-fixture";

const SRC = "https://github.com/obra/superpowers";
const MIN = 60_000;
let base: string;
let configDir: string;
let lookupDir: string;
let now: number;
let skills: SkillAdmin;
/** Fills the fake clone's repo dir; tests replace it to shape the repo. */
let repoFiles: (dir: string) => void;
let remoteHead: string;

const lock = () =>
  (Bun.YAML.parse(readFileSync(join(configDir, "skills", "skills.lock.yaml"), "utf8")) ??
    {}) as Record<string, unknown>;
const bot = (id: string) => readFileSync(join(configDir, "bots", `${id}.md`), "utf8");
const refused = (fn: () => unknown, code: string, text?: string) =>
  expect(fn).toThrow(
    expect.objectContaining({ code, ...(text && { message: expect.stringContaining(text) }) }),
  );

beforeEach(() => {
  const s = setup();
  ({ base, configDir } = s);
  lookupDir = join(s.home, "data", "skill-lookups");
  now = 1_000_000_000_000;
  remoteHead = "abc";
  repoFiles = (dir) => putSkill(join(dir, "skills"), "code-review");
  const ctx = {
    ...s.ctx,
    now: () => now,
    readBotFile: (id: string) =>
      existsSync(join(configDir, "bots", `${id}.md`))
        ? bot(id)
        : id === "friday"
          ? "---\nname: Friday\n---\n"
          : undefined,
  };
  writeFileSync(
    join(configDir, "bots", "dev.md"),
    "---\nname: Dev\nskills: [code-review, other]\n---\nHi\n",
  );
  writeFileSync(join(configDir, "bots", "ops.md"), "---\nname: Ops\n---\nHi\n");
  // A fake clone: a fixture repo in `<tmpRoot>/clone-<n>/repo`, with a VCS dir like a real clone.
  let n = 0;
  const clone = async (_src: string, o: { tmpRoot: string }) => {
    const dir = join(o.tmpRoot, `clone-${++n}`, "repo");
    mkdirSync(join(dir, ".git"), { recursive: true });
    repoFiles(dir);
    return {
      dir,
      sha: "abc",
      cleanup: () => rmSync(join(o.tmpRoot, `clone-${n}`), { recursive: true, force: true }),
    };
  };
  skills = createSkillAdmin({
    ctx,
    lookupDir,
    pathEnv: "/usr/bin",
    now: () => now,
    clone: clone as never,
    lsRemote: async () => `${remoteHead}\tHEAD\n`,
  });
});

test("install without a lookup is refused (not confirmed)", () => {
  refused(() => skills.install("nope", "code-review"), "BAD_REQUEST", "not confirmed");
  expect(existsSync(join(configDir, "skills", "code-review"))).toBe(false);
});

test("an expired lookup is refused", async () => {
  const l = await skills.lookup(SRC);
  now += 16 * MIN;
  refused(() => skills.install(l.lookupId, "code-review"), "BAD_REQUEST", "not confirmed");
  expect(existsSync(join(configDir, "skills", "code-review"))).toBe(false);
});

test("a name the lookup did not find is refused", async () => {
  const l = await skills.lookup(SRC);
  refused(() => skills.install(l.lookupId, "other"), "BAD_REQUEST");
  refused(() => skills.install(l.lookupId, "../x"), "BAD_REQUEST");
});

test("lookup installs nothing; install writes dir and lock with installedAt", async () => {
  const l = await skills.lookup(SRC);
  expect(l.skills.map((x) => x.name)).toEqual(["code-review"]);
  expect(l.skills[0]?.files).toContain("SKILL.md");
  expect(l.expiresAt).toBe(now + 15 * MIN);
  expect(existsSync(join(configDir, "skills", "code-review"))).toBe(false);
  const e = skills.install(l.lookupId, "code-review");
  expect(e.name).toBe("code-review");
  expect(existsSync(join(configDir, "skills", "code-review", "SKILL.md"))).toBe(true);
  expect(lock()["code-review"]).toEqual({
    source: SRC,
    sha: "abc",
    installedAt: expect.any(String),
  });
});

test("a lookup is used once", async () => {
  const l = await skills.lookup(SRC);
  skills.install(l.lookupId, "code-review");
  refused(() => skills.install(l.lookupId, "code-review"), "BAD_REQUEST", "not confirmed");
  expect(readdirSync(lookupDir)).toEqual([]);
});

test("installing an existing or shipped skill is a CONFLICT", async () => {
  putSkill(join(configDir, "skills"), "code-review");
  const l = await skills.lookup(SRC);
  refused(() => skills.install(l.lookupId, "code-review"), "CONFLICT");
  repoFiles = (dir) => putSkill(join(dir, "skills"), "shipped-one");
  const l2 = await skills.lookup(SRC);
  refused(() => skills.install(l2.lookupId, "shipped-one"), "CONFLICT");
});

test("lookup finds flat dirs, scripts, a root skill, and honours path", async () => {
  repoFiles = (dir) => {
    putSkill(dir, "a");
    putSkill(dir, "b");
    mkdirSync(join(dir, "b", "bin"));
    writeFileSync(join(dir, "b", "bin", "x.sh"), "echo");
    writeFileSync(join(dir, "b", "tool"), "x", { mode: 0o755 });
  };
  const l = await skills.lookup(SRC);
  expect(l.skills.map((x) => x.name)).toEqual(["a", "b"]);
  expect(l.skills[1]?.scripts.sort()).toEqual(["bin/x.sh", "tool"]);
  const p = await skills.lookup(SRC, "a");
  expect(p.skills.map((x) => x.name)).toEqual(["a"]);
  repoFiles = (dir) =>
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: rootie\ndescription: Does a thing well.\n---\n",
    );
  const r = await skills.lookup(SRC);
  expect(r.skills.map((x) => x.name)).toEqual(["rootie"]);
  expect(r.skills[0]?.files).toEqual(["SKILL.md"]);
  expect(skills.install(r.lookupId, "rootie").files).toEqual(["SKILL.md"]);
});

test("a path that escapes, is a symlink or is missing is refused with field path", async () => {
  repoFiles = (dir) => {
    putSkill(join(dir, "skills"), "code-review");
    mkdirSync(join(base, "outside"), { recursive: true });
    putSkill(join(base, "outside"), "evil");
    symlinkSync(join(base, "outside"), join(dir, "link"));
  };
  for (const p of ["link/evil", "link", "nope"])
    await expect(skills.lookup(SRC, p)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      field: "path",
    });
});

test("a bad source is refused and a repo with no skill is refused", async () => {
  await expect(skills.lookup("http://x.com/a")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  repoFiles = () => {};
  await expect(skills.lookup(SRC)).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("a sweep drops expired lookups and old leftovers, keeps young ones", async () => {
  const l = await skills.lookup(SRC);
  const stale = join(lookupDir, "clone-old");
  mkdirSync(stale, { recursive: true });
  utimesSync(stale, (now - 20 * MIN) / 1000, (now - 20 * MIN) / 1000);
  now += 16 * MIN;
  const young = join(lookupDir, "clone-young");
  mkdirSync(young);
  utimesSync(young, now / 1000, now / 1000);
  await skills.lookup(SRC);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(young)).toBe(true);
  refused(() => skills.install(l.lookupId, "code-review"), "BAD_REQUEST", "not confirmed");
  // the expired lookup's dir is gone; the young leftover and the new lookup remain
  expect(readdirSync(lookupDir).length).toBe(2);
});

test("update replaces an installed skill from the same source only", async () => {
  const l = await skills.lookup(SRC);
  skills.install(l.lookupId, "code-review");
  remoteHead = "def";
  expect(await skills.checkUpdate("code-review")).toEqual({
    sha: "abc",
    latestSha: "def",
    updateAvailable: true,
  });
  putSkill(join(configDir, "skills"), "mine");
  const l2 = await skills.lookup(SRC);
  refused(() => skills.update(l2.lookupId, "mine"), "BAD_REQUEST");
  skills.update(l2.lookupId, "code-review");
  expect(lock()["code-review"]).toMatchObject({ source: SRC });
  const l3 = await skills.lookup("https://github.com/other/repo");
  refused(() => skills.update(l3.lookupId, "code-review"), "BAD_REQUEST", "source");
  repoFiles = (dir) => putSkill(join(dir, "skills"), "shipped-one");
  const l4 = await skills.lookup(SRC);
  refused(() => skills.update(l4.lookupId, "shipped-one"), "BAD_REQUEST");
});

test("remove drops the skill from bot files and returns them", async () => {
  const l = await skills.lookup(SRC);
  skills.install(l.lookupId, "code-review");
  expect(skills.list().find((s) => s.name === "code-review")?.usedBy).toEqual(["dev"]);
  expect(skills.remove("code-review").botIds).toEqual(["dev"]);
  expect(existsSync(join(configDir, "skills", "code-review"))).toBe(false);
  expect(lock()["code-review"]).toBeUndefined();
  expect(bot("dev")).not.toContain("code-review");
  expect(bot("dev")).toContain("other");
});

test("remove of a shipped skill is refused; a missing or bad name too", () => {
  refused(() => skills.remove("shipped-one"), "BAD_REQUEST");
  refused(() => skills.remove("nope"), "NOT_FOUND");
  refused(() => skills.remove("../x"), "BAD_REQUEST");
});

test("setUsedBy edits only changed bots and refuses a shipped one", () => {
  putSkill(join(configDir, "skills"), "mine");
  const before = bot("dev");
  skills.setUsedBy("mine", ["ops"]);
  expect(bot("ops")).toContain("mine");
  expect(bot("dev")).toBe(before);
  refused(() => skills.setUsedBy("nope", []), "NOT_FOUND");
  refused(() => skills.setUsedBy("mine", ["ghost"]), "NOT_FOUND");
  refused(() => skills.setUsedBy("mine", ["ops", "friday"]), "BAD_REQUEST");
  expect(skills.setUsedBy("mine", []).usedBy).toEqual([]);
});

test("list shows shipped and installed skills", async () => {
  const l = await skills.lookup(SRC);
  skills.install(l.lookupId, "code-review");
  const all = skills.list();
  expect(all.find((s) => s.name === "shipped-one")?.shipped).toBe(true);
  const cr = all.find((s) => s.name === "code-review");
  expect(cr).toMatchObject({ shipped: false, source: SRC, sha: "abc", files: ["SKILL.md"] });
  expect(cr?.body).toContain("Body");
});

test("BotDesign install_skill still works and records installedAt", async () => {
  const s = setup();
  putSkill(join(s.scratchDir, "repo", "skills"), "pick");
  const from = join(s.scratchDir, "repo", "skills", "pick");
  const r = await call(createBotDesignTool(s.ctx), {
    action: "install_skill",
    id: "pick",
    from,
    source: "acme/skills",
  });
  expect(r.isError).toBeUndefined();
  expect(textOf(r)).toContain("Installed skill pick");
  const l = Bun.YAML.parse(
    readFileSync(join(s.configDir, "skills", "skills.lock.yaml"), "utf8"),
  ) as Record<string, unknown>;
  expect(l.pick).toMatchObject({
    source: "acme/skills",
    sha: "abc123",
    installedAt: expect.any(String),
  });
});
