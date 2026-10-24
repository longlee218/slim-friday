import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBotDesignTool } from "../src/design/tools/BotDesignTool/bot-design-tool";
import { call, putSkill, setup, textOf } from "./design-fixture";

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Helps with ${name} jobs when asked.\n---\nSteps.\n`;

test("write_skill writes the files; an existing or shipped name needs overwrite", async () => {
  const { ctx, configDir } = setup();
  const t = createBotDesignTool(ctx);
  const files = [
    { path: "SKILL.md", content: skill("mine") },
    { path: "references/a.md", content: "A" },
  ];
  expect((await call(t, { action: "write_skill", id: "mine", files })).isError).toBeUndefined();
  expect(readFileSync(join(configDir, "skills", "mine", "references", "a.md"), "utf8")).toBe("A");
  expect((await call(t, { action: "write_skill", id: "mine", files })).isError).toBe(true);
  expect(
    (await call(t, { action: "write_skill", id: "mine", files, overwrite: true })).isError,
  ).toBeUndefined();
  const shipped = [{ path: "SKILL.md", content: skill("shipped-one") }];
  expect(
    (await call(t, { action: "write_skill", id: "shipped-one", files: shipped })).isError,
  ).toBe(true);
});

test("write_skill refuses a bad name, a path escape, a missing or mismatched SKILL.md and oversize", async () => {
  const { ctx, configDir } = setup();
  const t = createBotDesignTool(ctx);
  const ok = [{ path: "SKILL.md", content: skill("mine") }];
  const cases = [
    { id: "../mine", files: ok },
    { id: "mine", files: [...ok, { path: "../evil.md", content: "x" }] },
    { id: "mine", files: [...ok, { path: "/abs.md", content: "x" }] },
    { id: "mine", files: [...ok, { path: ".hidden/x", content: "x" }] },
    { id: "mine", files: [{ path: "other.md", content: "x" }] },
    { id: "mine", files: [{ path: "SKILL.md", content: skill("different") }] },
    { id: "mine", files: [{ path: "SKILL.md", content: "no front matter" }] },
    { id: "mine", files: [...ok, { path: "big.bin", content: "x".repeat(300_000) }] },
  ];
  for (const c of cases)
    expect((await call(t, { action: "write_skill", ...c })).isError).toBe(true);
  expect(existsSync(join(configDir, "skills", "mine"))).toBe(false);
});

/** A cloned skill dir in the scratch dir. */
function clone(scratchDir: string, name = "pick") {
  const dir = join(scratchDir, "repo", "skills", name);
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skill(name));
  writeFileSync(join(dir, "references", "r.md"), "R");
  return dir;
}

test("install_skill copies a skill from the scratch dir, records source and sha, refuses overwrite", async () => {
  const { ctx, scratchDir, configDir } = setup();
  const t = createBotDesignTool(ctx);
  const from = clone(scratchDir);
  const r = await call(t, { action: "install_skill", id: "pick", from, source: "acme/skills" });
  expect(r.isError).toBeUndefined();
  expect(readFileSync(join(configDir, "skills", "pick", "references", "r.md"), "utf8")).toBe("R");
  const lock = readFileSync(join(configDir, "skills", "skills.lock.yaml"), "utf8");
  expect(lock).toContain("acme/skills");
  expect(lock).toContain("abc123");
  expect(
    (await call(t, { action: "install_skill", id: "pick", from, source: "acme/skills" })).isError,
  ).toBe(true);
});

test("install_skill refuses a dir outside the scratch dir, a symlink, a VCS dir, a name mismatch and too many files", async () => {
  const { ctx, scratchDir, base, configDir } = setup();
  const t = createBotDesignTool(ctx);
  const args = (from: string, id = "pick") => ({
    action: "install_skill",
    id,
    from,
    source: "a/b",
  });
  const outside = join(base, "elsewhere");
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), skill("pick"));
  expect((await call(t, args(outside))).isError).toBe(true);
  expect((await call(t, args("relative/path"))).isError).toBe(true);
  const linked = clone(scratchDir, "linked");
  symlinkSync(join(base, "elsewhere", "SKILL.md"), join(linked, "link.md"));
  expect((await call(t, args(linked, "linked"))).isError).toBe(true);
  const vcs = clone(scratchDir, "vcs");
  mkdirSync(join(vcs, ".git"));
  expect((await call(t, args(vcs, "vcs"))).isError).toBe(true);
  expect((await call(t, args(clone(scratchDir, "real"), "other"))).isError).toBe(true);
  const many = clone(scratchDir, "many");
  for (let i = 0; i < 120; i++) writeFileSync(join(many, `f${i}.md`), "x");
  expect((await call(t, args(many, "many"))).isError).toBe(true);
  expect(existsSync(join(configDir, "skills", "pick"))).toBe(false);
});

/** An env reference, spelled in two parts so lint does not read it as a template. */
const REF = "$" + "{SOME_API_KEY}";
const stdio = {
  type: "stdio",
  command: "npx",
  args: ["-y", "some-mcp@1.0.0"],
  env: { API_KEY: REF },
};

test("set_mcp writes mcp.yaml, keeps other servers, and replaces only with overwrite", async () => {
  const { ctx, configDir } = setup();
  const t = createBotDesignTool(ctx);
  expect((await call(t, { action: "set_mcp", id: "some", server: stdio })).isError).toBeUndefined();
  expect(
    (
      await call(t, {
        action: "set_mcp",
        id: "other",
        server: { type: "http", url: "https://x.example/mcp" },
      })
    ).isError,
  ).toBeUndefined();
  const text = readFileSync(join(configDir, "mcp.yaml"), "utf8");
  expect(text).toContain("some:");
  expect(text).toContain("other:");
  expect(text).toContain(REF);
  expect((await call(t, { action: "set_mcp", id: "some", server: stdio })).isError).toBe(true);
  expect(
    (await call(t, { action: "set_mcp", id: "some", server: stdio, overwrite: true })).isError,
  ).toBeUndefined();
});

test("set_mcp refuses a literal secret, a reserved or shipped name, a bad name and a server the schema refuses", async () => {
  const { ctx, configDir } = setup();
  const t = createBotDesignTool(ctx);
  const cases = [
    { id: "x", server: { ...stdio, env: { API_KEY: "sk-ant-abcdefghijklmnop" } } },
    { id: "x", server: { ...stdio, env: { API_KEY: "plainvalue" } } },
    { id: "x", server: { ...stdio, args: ["--token", "ghp_abcdefghijklmnopqrstuvwxyz0123"] } },
    {
      id: "x",
      server: {
        type: "http",
        url: "https://x.example",
        headers: { Authorization: "Bearer abcdefgh12345" },
      },
    },
    { id: "memory", server: stdio },
    { id: "playwright", server: stdio },
    { id: "Bad Name", server: stdio },
    { id: "x", server: { type: "stdio" } },
  ];
  for (const c of cases) expect((await call(t, { action: "set_mcp", ...c })).isError).toBe(true);
  const bad = setup({
    checkMcp: () => {
      throw new Error("schema says no");
    },
  });
  const r = await call(createBotDesignTool(bad.ctx), { action: "set_mcp", id: "x", server: stdio });
  expect(textOf(r)).toContain("schema says no");
  expect(existsSync(join(configDir, "mcp.yaml"))).toBe(false);
  putSkill(configDir, "unused");
});
