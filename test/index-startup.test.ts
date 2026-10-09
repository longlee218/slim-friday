import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { readLogLines } from "./helpers";

/** Run src/index.ts as a real subprocess with the given Discord env. */
async function runIndex(
  discord: Record<string, string>,
  home = mkdtempSync(join(tmpdir(), "friday-idx-")),
): Promise<{ code: number; log: string }> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "index.ts")], {
    // cwd outside the repo so Bun does not auto-load the real .env
    cwd: home,
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      AGENT_HOME: home,
      ...discord,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await Promise.race([
    proc.exited,
    Bun.sleep(8000).then(() => {
      proc.kill();
      return -1;
    }),
  ]);
  // Empty when no log was written (process killed early).
  const log = readLogLines(workspacePaths(home).appLog())
    .map((l) => l.msg)
    .join("\n");
  return { code, log };
}

test("exits 1 without connecting when Discord env is placeholder", async () => {
  expect(
    (await runIndex({ DISCORD_TOKEN: "REPLACE_ME", OWNER_DISCORD_ID: "REPLACE_ME" })).code,
  ).toBe(1);
});

test("exits 1 when Discord env is missing", async () => {
  expect((await runIndex({})).code).toBe(1);
});

test("exits 1 before Discord login when the resolved provider has no credential", async () => {
  // Real-looking (fake) Discord env, no LLM credential: must stop on the provider check.
  const r = await runIndex({ DISCORD_TOKEN: "fake.discord.token", OWNER_DISCORD_ID: "1" });
  expect(r.code).toBe(1);
  expect(r.log).toContain("No credential for provider anthropic");
  expect(r.log).not.toContain("discord login failed");
});

test("exits 1 when a workspace lists channels but DISCORD_GUILD_ID is not set", async () => {
  const home = mkdtempSync(join(tmpdir(), "friday-idx-"));
  const ws = workspacePaths(home).workspace("w");
  mkdirSync(ws.root, { recursive: true });
  writeFileSync(ws.config, 'channels:\n  - "100000000000000001"\n');
  const r = await runIndex(
    { DISCORD_TOKEN: "fake.discord.token", OWNER_DISCORD_ID: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    home,
  );
  expect(r.code).toBe(1);
  expect(r.log).toContain("DISCORD_GUILD_ID required");
});

test("exits 1 when discord.yaml is unparsable (fail closed)", async () => {
  const home = mkdtempSync(join(tmpdir(), "friday-idx-"));
  writeFileSync(join(home, "discord.yaml"), "ops: [unclosed");
  const r = await runIndex(
    { DISCORD_TOKEN: "fake.discord.token", OWNER_DISCORD_ID: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    home,
  );
  expect(r.code).toBe(1);
  expect(r.log).toContain("discord.yaml");
  expect(r.log).not.toContain("discord login failed");
});

test("exits 1 when AGENT_HOME sits inside a git working tree", async () => {
  const tree = mkdtempSync(join(tmpdir(), "friday-idx-"));
  mkdirSync(join(tree, ".git"));
  const home = join(tree, "friday-home");
  mkdirSync(home);
  const r = await runIndex(
    { DISCORD_TOKEN: "fake.discord.token", OWNER_DISCORD_ID: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    home,
  );
  expect(r.code).toBe(1);
  expect(r.log).toContain("AGENT_HOME is inside a git working tree");
});

test("startup creates the root persona files in an empty home (no workspaces), before any Discord login", async () => {
  const home = mkdtempSync(join(tmpdir(), "friday-idx-"));
  // Stops later at the discord.yaml check, after ensureHome has run.
  writeFileSync(join(home, "discord.yaml"), "ops: [unclosed");
  const r = await runIndex(
    { DISCORD_TOKEN: "fake.discord.token", OWNER_DISCORD_ID: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    home,
  );
  expect(r.code).toBe(1);
  const p = workspacePaths(home);
  for (const f of [p.identity, p.soul, p.user, p.memory, p.agents, p.bootstrap])
    expect(existsSync(f)).toBe(true);
});
