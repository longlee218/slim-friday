import { expect, test } from "bun:test";
import { MAX_RUNNING_PER_THREAD as CAP, PRIORITY_AGING_MS } from "../src/config/lead-caps";
import { pickDispatchable, type RoleCaps } from "../src/orchestrator/worker/scheduler";
import { itemRow } from "./lead-fake-port";

// Pure scheduler: which ready items start now. Roles: dev = writer, scout = free.
const caps = (role: string | null): RoleCaps => ({ writer: role === "dev" });
const it = (id: string, status: string, role: string, location: string | null = null) =>
  itemRow({ id, itemKey: id, status, ownerRole: role, location });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("ready items start in creation order, up to the thread cap", () => {
  const items = Array.from({ length: CAP + 1 }, (_, i) => it(`r${i}`, "ready", "scout"));
  expect(ids(pickDispatchable(items, caps))).toEqual(ids(items.slice(0, CAP)));
});

test("running items count against the thread cap", () => {
  const items = [
    it("a", "running", "scout"),
    ...Array.from({ length: CAP }, (_, i) => it(`r${i}`, "ready", "scout")),
  ];
  expect(ids(pickDispatchable(items, caps))).toEqual(ids(items.slice(1, CAP)));
  const full = Array.from({ length: CAP }, (_, i) => it(`a${i}`, "running", "scout"));
  expect(pickDispatchable([...full, it("c", "ready", "scout")], caps)).toEqual([]);
});

test("one writer per location: same location waits, another location starts", () => {
  const items = [
    it("a", "ready", "dev", "repo1"),
    it("b", "ready", "dev", "repo1"),
    it("c", "ready", "dev", "repo2"),
  ];
  expect(ids(pickDispatchable(items, caps))).toEqual(["a", "c"]);
  const running = [it("r", "running", "dev", "repo1"), it("b", "ready", "dev", "repo1")];
  expect(pickDispatchable(running, caps)).toEqual([]);
});

test("a writer with no location chosen collides with every writer; a non-writer never collides", () => {
  expect(
    ids(pickDispatchable([it("a", "ready", "dev"), it("b", "ready", "dev", "repo1")], caps)),
  ).toEqual(["a"]);
  expect(
    ids(
      pickDispatchable(
        [it("r", "running", "dev", "repo1"), it("s", "ready", "scout", "repo1")],
        caps,
      ),
    ),
  ).toEqual(["s"]);
});

test("deterministic: the same items give the same pick; pending / terminal items are never picked", () => {
  const items = [
    it("a", "pending", "scout"),
    it("b", "completed", "scout"),
    it("c", "ready", "scout"),
  ];
  expect(pickDispatchable(items, caps)).toEqual(pickDispatchable(items, caps));
  expect(ids(pickDispatchable(items, caps))).toEqual(["c"]);
});

test("property: random DAG states never exceed the thread cap nor 2 writers on one location", () => {
  const roles = ["dev", "scout", "one"];
  const locs = [null, "repo1", "repo2"];
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 300; round++) {
    const items = Array.from({ length: 1 + rnd(8) }, (_, i) =>
      it(
        `i${i}`,
        ["ready", "running", "pending", "completed"][rnd(4)] as string,
        roles[rnd(3)] as string,
        locs[rnd(3)] ?? null,
      ),
    );
    const picked = pickDispatchable(items, caps);
    const after = [...items.filter((i) => i.status === "running"), ...picked];
    if (items.filter((i) => i.status === "running").length <= CAP)
      expect(after.length).toBeLessThanOrEqual(CAP);
    const writers = after.filter((i) => caps(i.ownerRole).writer);
    const pickedWriters = picked.filter((i) => caps(i.ownerRole).writer);
    for (const p of pickedWriters)
      expect(
        writers.filter((w) => w !== p && (w.location === p.location || !w.location || !p.location)),
      ).toEqual([]);
  }
});

test("a waiting_user item has no run: it holds neither its location nor a thread slot", () => {
  const items = [
    it("w", "waiting_user", "dev", "repo1"),
    it("b", "ready", "dev", "repo1"),
    it("c", "ready", "scout"),
  ];
  expect(ids(pickDispatchable(items, caps))).toEqual(["b", "c"]);
});

test("priority: urgent starts before high before normal, equal priority keeps creation order, nothing is preempted", () => {
  const p = (id: string, priority: number, status = "ready") =>
    itemRow({ id, itemKey: id, status, ownerRole: "scout", priority });
  const items = [p("n1", 0), p("h1", 10), p("n2", 0), p("u1", 100), p("h2", 10)];
  expect(ids(pickDispatchable(items, caps))).toEqual(["u1", "h1", "h2", "n1"]); // cap = 4
  // A full thread of running items takes nothing, whatever the priority of the waiting one.
  const full = Array.from({ length: CAP }, (_, i) => p(`run${i}`, 0, "running"));
  expect(pickDispatchable([...full, p("u2", 100)], caps)).toEqual([]);
});

test("priority orders writers of one location: the urgent one takes the location first", () => {
  const w = (id: string, priority: number) =>
    itemRow({ id, itemKey: id, status: "ready", ownerRole: "dev", location: "repo1", priority });
  expect(ids(pickDispatchable([w("old", 0), w("new", 100)], caps))).toEqual(["new"]);
});

test("aging: a normal item that waited over the aging limit is not starved by newer urgent items", () => {
  const now = Date.now();
  const w = (id: string, priority: number, lastProgressAt: number) =>
    itemRow({
      id,
      itemKey: id,
      status: "ready",
      ownerRole: "dev",
      location: "repo1",
      priority,
      lastProgressAt,
    });
  const old = w("old", 0, now - PRIORITY_AGING_MS - 1);
  const fresh = w("new", 100, now);
  expect(ids(pickDispatchable([old, fresh], caps, undefined, undefined, now))).toEqual(["old"]);
  // Not yet aged: the urgent one still goes first.
  const young = w("young", 0, now - PRIORITY_AGING_MS + 1000);
  expect(ids(pickDispatchable([young, fresh], caps, undefined, undefined, now))).toEqual(["new"]);
});
