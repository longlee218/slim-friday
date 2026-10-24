import { afterEach, expect, test } from "bun:test";
import { openEngineStore } from "@friday/store-sqlite";
import { eventually, workerHarness } from "./worker-harness";

/** Stops of the apps a test started (each stops its workers and closes its db). */
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

/** Main plus `n` worker processes; stopped after the test. */
async function boot(n: number, home?: string) {
  const h = await workerHarness(n, home);
  stops.push(() => h.app.stop());
  return h;
}

test("worker-flow: owner message -> worker claims -> text reaches the event bus", async () => {
  const h = await boot(1);
  await h.send("hello");
  await eventually(() => h.botTexts().includes("echo: hello"));
  // The working sign came over IPC before the answer.
  const typing = h.events.findIndex((e) => e.type === "activity" && e.kind === "typing");
  const answer = h.events.findIndex(
    (e) => e.type === "message" && e.message.text === "echo: hello",
  );
  expect(typing).toBeGreaterThanOrEqual(0);
  expect(typing).toBeLessThan(answer);
  // A worker ran it: main's own runtime never opened a session, and nothing is left in flight.
  expect(h.mainRuntime.created).toHaveLength(0);
  expect(await h.engine.wakes.inFlight()).toEqual([]);
}, 30_000);

test("killing a worker mid-run lets the other worker resume it with the cut note", async () => {
  const h = await boot(2);
  await h.send("hang on this");
  let owner = "";
  let id = "";
  await eventually(async () => {
    const row = (await h.engine.wakes.inFlight())[0];
    owner = row?.status === "running" ? (row.leaseOwner ?? "") : "";
    id = row?.id ?? "";
    return owner !== "";
  });
  const index = Number(owner.split(":w")[1]);
  expect(owner).toBe(`${h.boot}:w${index}`);
  h.app.workers?.handle(index)?.kill("SIGKILL");
  await eventually(() => h.botTexts().includes("resumed: hang on this"));
  const row = await h.engine.wakes.get(id);
  expect(row).toMatchObject({ status: "done", cuts: 1 });
  expect(row?.leaseOwner).not.toBe(owner);
}, 30_000);

test("worker disconnect marks its attempts interrupted; the next claim resumes without a cut", async () => {
  const h = await boot(1);
  await h.send("hang here");
  let id = "";
  await eventually(async () => {
    const row = (await h.engine.wakes.inFlight())[0];
    id = row?.status === "running" ? row.id : "";
    return id !== "";
  });
  // Main stops: the IPC channel closes and the worker requeues its run before it exits.
  await stops.pop()?.();
  const db = openEngineStore(`${h.home}/data/engine.db`);
  try {
    expect(await db.wakes.get(id)).toMatchObject({ status: "queued", cuts: 0, leaseFence: 1 });
    expect(await db.attempts.status(`${id}:1`)).toBe("interrupted");
  } finally {
    db.close();
  }
  // The next start resumes the run with the cut note and still counts no cut.
  const again = await boot(1, h.home);
  await eventually(() => again.botTexts().includes("resumed: hang here"));
  expect(await again.engine.wakes.get(id)).toMatchObject({ status: "done", cuts: 0 });
}, 30_000);
