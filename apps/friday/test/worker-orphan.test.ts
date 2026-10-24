import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** True while a process with this pid exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a worker whose main is SIGKILLed exits by the deadline even with a run that never settles", async () => {
  const home = mkdtempSync(join(tmpdir(), "orphan-"));
  const main = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures", "orphan-main.ts"), home],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  // Read until the worker's pid is printed (the run is then running in it).
  let out = "";
  const reader = main.stdout.getReader();
  const deadline = Date.now() + 20_000;
  while (!/WORKER_PID (\d+)/.test(out) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  const pid = Number(/WORKER_PID (\d+)/.exec(out)?.[1]);
  expect(pid).toBeGreaterThan(0);
  expect(alive(pid)).toBe(true);
  main.kill("SIGKILL");
  await main.exited;
  // Settle wait 1 s, then the dbs close and it exits; the hard deadline is 1 s + 5 s.
  const killedAt = Date.now();
  while (alive(pid) && Date.now() - killedAt < 8_000) await Bun.sleep(50);
  expect(alive(pid)).toBe(false);
  const took = Date.now() - killedAt;
  // It waited the settle time for the stuck run (so the run really hung), then left anyway.
  expect(took).toBeGreaterThanOrEqual(900);
  expect(took).toBeLessThan(8_000);
}, 40_000);
