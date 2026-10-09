import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MemoryBusyError,
  MemorySymlinkError,
  withMemoryLock,
  writeAtomic,
} from "../src/memory/memory-file-lock";
import { assertTempHome } from "./helpers";

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "friday-lock-"));
  assertTempHome(dir);
  return join(dir, "MEMORY.md");
}

test("lock is created with our PID, released after fn and after a throw", () => {
  const f = tmpFile();
  withMemoryLock(f, () => {
    expect(Bun.file(`${f}.lock`).size).toBeGreaterThan(0);
    expect(require("node:fs").readFileSync(`${f}.lock`, "utf8")).toBe(String(process.pid));
  });
  expect(existsSync(`${f}.lock`)).toBe(false);
  expect(() =>
    withMemoryLock(f, () => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(existsSync(`${f}.lock`)).toBe(false);
});

test("a live holder blocks: writer waits then times out with MemoryBusyError", () => {
  const f = tmpFile();
  writeFileSync(`${f}.lock`, String(process.pid)); // alive (us), fresh
  const t0 = Date.now();
  expect(() => withMemoryLock(f, () => 1, { waitMs: 200 })).toThrow(MemoryBusyError);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  expect(existsSync(`${f}.lock`)).toBe(true); // not ours: left alone
});

test("stale lock (dead PID) is reclaimed", () => {
  const f = tmpFile();
  writeFileSync(`${f}.lock`, "2147483646"); // no such process
  expect(withMemoryLock(f, () => "ok", { waitMs: 500 })).toBe("ok");
  writeFileSync(`${f}.lock`, "garbage");
  const old = new Date(Date.now() - 5000);
  utimesSync(`${f}.lock`, old, old); // unreadable AND older than the 2 s grace
  expect(withMemoryLock(f, () => "ok2", { waitMs: 500 })).toBe("ok2");
});

test("stale lock (alive PID but older than 10 min) is reclaimed", () => {
  const f = tmpFile();
  writeFileSync(`${f}.lock`, String(process.pid));
  const old = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(`${f}.lock`, old, old);
  expect(withMemoryLock(f, () => "ok", { waitMs: 500 })).toBe("ok");
});

test("writeAtomic leaves no tmp file", () => {
  const f = tmpFile();
  writeAtomic(f, "hello");
  expect(require("node:fs").readFileSync(f, "utf8")).toBe("hello");
  expect(existsSync(`${f}.tmp`)).toBe(false);
});

test("an empty or unreadable lock younger than 2 s is LIVE (never stolen mid-create)", () => {
  const f = tmpFile();
  writeFileSync(`${f}.lock`, ""); // what a half-created lock looks like
  expect(() => withMemoryLock(f, () => 1, { waitMs: 300 })).toThrow(MemoryBusyError);
  expect(existsSync(`${f}.lock`)).toBe(true);
  const old = new Date(Date.now() - 5000);
  utimesSync(`${f}.lock`, old, old);
  expect(withMemoryLock(f, () => "ok", { waitMs: 500 })).toBe("ok");
});

test("the lock is created with its content and leaves no temp files", () => {
  const f = tmpFile();
  withMemoryLock(f, () => {
    expect(readdirSync(dirname(f)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
  expect(readdirSync(dirname(f))).toEqual([]);
});

test("cross-process: a child holding the lock blocks the parent; a killed holder is reclaimed", async () => {
  const f = tmpFile();
  const mod = join(import.meta.dir, "../src/memory/memory-file-lock.ts");
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `import { withMemoryLock } from ${JSON.stringify(mod)};
       withMemoryLock(${JSON.stringify(f)}, () => { console.log("held"); Bun.sleepSync(20000); });`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read(); // wait until the child really holds it
    expect(new TextDecoder().decode(first.value)).toContain("held");
    expect(() => withMemoryLock(f, () => 1, { waitMs: 300 })).toThrow(MemoryBusyError);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  // the dead holder's lock is stale (PID gone): reclaimed
  expect(withMemoryLock(f, () => "ok", { waitMs: 2000 })).toBe("ok");
}, 20000);

test("a symlinked memory file is refused", () => {
  const f = tmpFile();
  writeFileSync(`${f}.real`, "# x\n");
  symlinkSync(`${f}.real`, f);
  expect(() => withMemoryLock(f, () => 1)).toThrow(MemorySymlinkError);
});
