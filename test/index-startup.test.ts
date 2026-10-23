import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { readLogLines } from "./helpers";

/** Each test spawns the real bot process (~1.5 s alone); under full-suite load that can pass 5 s. */
setDefaultTimeout(20_000);

/** Run src/index.ts as a real subprocess with the given Discord env. */
async function runIndex(
  discord: Record<string, string>,
  home = mkdtempSync(join(tmpdir(), "friday-idx-")),
): Promise<{ code: number; log: string }> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "index.ts")], {
    // cwd outside the location so Bun does not auto-load the real .env
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

test("exits 1 before Discord login when there is no credential", async () => {
  // Real-looking (fake) Discord env, no LLM credential: must stop on the credential check.
  const r = await runIndex({ DISCORD_TOKEN: "fake.discord.token", OWNER_DISCORD_ID: "1" });
  expect(r.code).toBe(1);
  expect(r.log).toContain("CLAUDE_CODE_OAUTH_TOKEN missing or placeholder");
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

test("boots with only a credential: creates the persona files, logs engine.absent, exits 0 on SIGTERM", async () => {
  const home = mkdtempSync(join(tmpdir(), "friday-idx-"));
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "index.ts")], {
    cwd: home,
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      AGENT_HOME: home,
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const logFile = workspacePaths(home).appLog();
  // Wait (bounded) for the boot line, then ask the process to stop.
  for (let i = 0; i < 100; i++) {
    if (readLogLines(logFile).some((l) => l.msg === "engine.absent")) break;
    await Bun.sleep(100);
  }
  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(0);
  const p = workspacePaths(home);
  for (const f of [p.identity, p.soul, p.user, p.memory, p.agents, p.bootstrap])
    expect(existsSync(f)).toBe(true);
});
