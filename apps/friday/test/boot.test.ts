import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homePaths } from "../src/config/home-paths";
import { bootFriday } from "../src/lifecycle/boot";
import { loadBootState } from "../src/lifecycle/boot-checks";
import { sweepHome } from "../src/lifecycle/home-retention-sweeper";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "friday-boot-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("boot runs the engine, never opens the old db, and stops on abort", async () => {
  const ac = new AbortController();
  let ran = false;
  const done = bootFriday({
    agentHome: home,
    signal: ac.signal,
    startEngine: async (signal) => {
      ran = true;
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    },
    onReady: () => queueMicrotask(() => ac.abort()),
  });
  await done;
  expect(ran).toBe(true);
  expect(existsSync(join(home, "data", "agent.db"))).toBe(false);
});

test("boot without an engine waits for the signal", async () => {
  const ac = new AbortController();
  const done = bootFriday({
    agentHome: home,
    signal: ac.signal,
    onReady: () => queueMicrotask(() => ac.abort()),
  });
  await done;
});

test("loadBootState refuses a missing credential by name and a home inside a git tree", () => {
  expect(() => loadBootState({ AGENT_HOME: home })).toThrow("CLAUDE_CODE_OAUTH_TOKEN");
  const tree = mkdtempSync(join(tmpdir(), "friday-tree-"));
  mkdirSync(join(tree, ".git"));
  mkdirSync(join(tree, "home"));
  expect(() =>
    loadBootState({ AGENT_HOME: join(tree, "home"), CLAUDE_CODE_OAUTH_TOKEN: "tok" }),
  ).toThrow("git working tree");
  expect(loadBootState({ AGENT_HOME: home, CLAUDE_CODE_OAUTH_TOKEN: "tok" }).config.agentHome).toBe(
    home,
  );
});

test("the sweep removes inbox dirs and app logs past their age and keeps fresh ones", () => {
  const paths = homePaths(home);
  const old = (p: string, days: number) => {
    const t = (Date.now() - days * 86_400_000) / 1000;
    utimesSync(p, t, t);
  };
  const oldDir = join(paths.inbox, "c1", "100");
  const freshDir = join(paths.inbox, "c1", "200");
  for (const d of [oldDir, freshDir]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "f.txt"), "x");
  }
  old(join(oldDir, "f.txt"), 2);
  old(oldDir, 2);
  mkdirSync(paths.logs, { recursive: true });
  const oldLog = join(paths.logs, "app.2020-01-01.1.jsonl");
  const freshLog = join(paths.logs, "app.2099-01-01.1.jsonl");
  writeFileSync(oldLog, "x");
  writeFileSync(freshLog, "x");
  old(oldLog, 30);
  sweepHome(home);
  expect(existsSync(oldDir)).toBe(false);
  expect(existsSync(freshDir)).toBe(true);
  expect(existsSync(oldLog)).toBe(false);
  expect(existsSync(freshLog)).toBe(true);
});
