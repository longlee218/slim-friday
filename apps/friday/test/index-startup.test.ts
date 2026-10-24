import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homePaths } from "../src/config/home-paths";

/** Each test spawns the real bot process (~1.5 s alone); under full-suite load that can pass 5 s. */
setDefaultTimeout(20_000);

/** Run src/index.ts as a real subprocess with the given env. */
async function runIndex(
  extra: Record<string, string>,
  home = mkdtempSync(join(tmpdir(), "friday-idx-")),
): Promise<{ code: number; log: string }> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "index.ts")], {
    // cwd outside the location so Bun does not auto-load the real .env
    cwd: home,
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      AGENT_HOME: home,
      ...extra,
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
  // Rolled files are `app.<date>.<n>.jsonl` in the logs dir; empty when no log was written (killed early).
  const logs = homePaths(home).logs;
  const files = existsSync(logs) ? readdirSync(logs).filter((f) => f.startsWith("app.")) : [];
  const log = files
    .flatMap((f) => readFileSync(join(logs, f), "utf8").split("\n").filter(Boolean))
    .map((l) => (JSON.parse(l) as { msg?: string }).msg ?? "")
    .join("\n");
  return { code, log };
}

/** Web values only: the R2 ones stay unset. */
const WEB = {
  WEB_ORIGIN: "https://friday.example.com",
  PUBLIC_API_URL: "https://friday-api.example.com",
  AUTH_SECRET: "x".repeat(32),
  OWNER_EMAIL: "owner@example.com",
};

test("exits 1 when the env is empty", async () => {
  expect((await runIndex({})).code).toBe(1);
});

test("exits 1 on the credential check when there is no credential", async () => {
  const r = await runIndex(WEB);
  expect(r.code).toBe(1);
  expect(r.log).toContain("CLAUDE_CODE_OAUTH_TOKEN missing or placeholder");
});

test("exits 1 when AGENT_HOME sits inside a git working tree", async () => {
  const tree = mkdtempSync(join(tmpdir(), "friday-idx-"));
  mkdirSync(join(tree, ".git"));
  const home = join(tree, "friday-home");
  mkdirSync(home);
  const r = await runIndex({ ...WEB, CLAUDE_CODE_OAUTH_TOKEN: "tok" }, home);
  expect(r.code).toBe(1);
  expect(r.log).toContain("AGENT_HOME is inside a git working tree");
});

test("boots with a credential and the web values but no R2: exits 1 naming R2_ACCOUNT_ID", async () => {
  const r = await runIndex({ ...WEB, CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  expect(r.code).toBe(1);
  expect(r.log).toContain("R2_ACCOUNT_ID missing");
});

test("boots with only a credential: refuses on the first missing web value, exits 1", async () => {
  const r = await runIndex({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  expect(r.code).toBe(1);
  expect(r.log).toContain("WEB_ORIGIN missing");
});
