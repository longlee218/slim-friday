import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/agent-config";
import { acquireMainLock, mainLockPath } from "../src/lifecycle/main-lock";
import { startEngine } from "../src/main";

/** A new agent home. */
const home = () => mkdtempSync(join(tmpdir(), "lock-"));

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}

test("the main lock is exclusive while its holder lives and released on stop", () => {
  const h = home();
  const release = acquireMainLock(h, process.pid);
  expect(readFileSync(mainLockPath(h), "utf8")).toBe(String(process.pid));
  // Another main (any other pid) is refused, naming the live holder.
  expect(() => acquireMainLock(h, process.pid + 1_000_000)).toThrow(
    `Another Friday main process (pid ${process.pid})`,
  );
  release();
  expect(existsSync(mainLockPath(h))).toBe(false);
});

test("a lock left by a dead main is taken over", async () => {
  const h = home();
  mkdirSync(join(h, "data"), { recursive: true });
  writeFileSync(mainLockPath(h), String(await deadPid()));
  const release = acquireMainLock(h, process.pid);
  expect(readFileSync(mainLockPath(h), "utf8")).toBe(String(process.pid));
  release();
});

test("startEngine refuses to start while another main holds the home, before opening the db", async () => {
  const h = home();
  mkdirSync(join(h, "data"), { recursive: true });
  // The parent of the test runner is alive and is not this process.
  writeFileSync(mainLockPath(h), String(process.ppid));
  const env = {
    AGENT_HOME: h,
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
    WEB_ORIGIN: "https://friday.example.com",
    PUBLIC_API_URL: "https://friday-api.example.com",
    AUTH_SECRET: "x".repeat(32),
    OWNER_EMAIL: "owner@example.com",
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "bucket",
  };
  const err = await startEngine({
    config: loadConfig(env),
    agentHome: h,
    signal: new AbortController().signal,
  }).catch((e) => e as Error);
  expect((err as Error).message).toContain(`pid ${process.ppid}`);
  expect(existsSync(join(h, "data", "engine.db"))).toBe(false);
  // The other main's lock is left alone.
  expect(readFileSync(mainLockPath(h), "utf8")).toBe(String(process.ppid));
});

test("a lock file without a pid (older or damaged) is taken over; a fresh lock is never empty", () => {
  const h = home();
  mkdirSync(join(h, "data"), { recursive: true });
  writeFileSync(mainLockPath(h), "");
  const release = acquireMainLock(h, process.pid);
  // Created by link from a written temp file: the pid is there from the first moment, and no temp is left.
  expect(readFileSync(mainLockPath(h), "utf8")).toBe(String(process.pid));
  expect(readdirSync(join(h, "data")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  release();
});
