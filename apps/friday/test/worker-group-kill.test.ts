import { expect, test } from "bun:test";
import { join } from "node:path";
import { killGroup, spawnInGroup } from "../src/workers/worker-spawn";

/** True while a process with this pid exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("killGroup signals the whole process group and ignores a group that is gone", () => {
  const calls: [number, string][] = [];
  killGroup(42, "SIGKILL", (pid, sig) => calls.push([pid, sig]));
  expect(calls).toEqual([[-42, "SIGKILL"]]);
  expect(() =>
    killGroup(42, "SIGKILL", () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }),
  ).not.toThrow();
});

test("a worker killed alone (kill -9 of its pid) takes its children with it", async () => {
  let sleeper = 0;
  const h = spawnInGroup(
    [process.execPath, join(import.meta.dir, "fixtures", "group-leader.ts")],
    (m) => {
      sleeper = (m as { sleeper: number }).sleeper;
    },
  );
  const deadline = Date.now() + 10_000;
  while (!sleeper && Date.now() < deadline) await Bun.sleep(20);
  expect(sleeper).toBeGreaterThan(0);
  expect(alive(sleeper)).toBe(true);
  // Only the worker's own pid, as the OOM killer would: its child would be reparented and live on.
  process.kill(h.pid as number, "SIGKILL");
  await h.exited;
  const killedAt = Date.now();
  while (alive(sleeper) && Date.now() - killedAt < 3_000) await Bun.sleep(20);
  expect(alive(sleeper)).toBe(false);
}, 20_000);
