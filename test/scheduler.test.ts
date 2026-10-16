import { expect, test } from "bun:test";
import { pickDispatchable, type RoleCaps } from "../src/orchestrator/worker/scheduler";
import { itemRow } from "./lead-fake-port";

// Pure scheduler: which ready items start now. Roles: dev = writer, scout = free, one = at most one run at a time.
const caps = (role: string | null): RoleCaps =>
  role === "dev"
    ? { writer: true }
    : role === "one"
      ? { writer: false, concurrency: 1 }
      : { writer: false };
const it = (id: string, status: string, role: string, location: string | null = null) =>
  itemRow({ id, itemKey: id, status, ownerRole: role, location });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("ready items start in creation order, up to the thread cap (2)", () => {
  const items = [it("a", "ready", "scout"), it("b", "ready", "scout"), it("c", "ready", "scout")];
  expect(ids(pickDispatchable(items, caps))).toEqual(["a", "b"]);
});

test("running items count against the thread cap", () => {
  const items = [it("a", "running", "scout"), it("b", "ready", "scout"), it("c", "ready", "scout")];
  expect(ids(pickDispatchable(items, caps))).toEqual(["b"]);
  expect(
    pickDispatchable(
      [it("a", "running", "scout"), it("b", "running", "scout"), it("c", "ready", "scout")],
      caps,
    ),
  ).toEqual([]);
});

test("role concurrency: a second run of a limited role waits, the next item still starts", () => {
  const items = [it("a", "running", "one"), it("b", "ready", "one"), it("c", "ready", "scout")];
  expect(ids(pickDispatchable(items, caps))).toEqual(["c"]);
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

test("property: random DAG states never exceed 2 running per thread nor 2 writers on one location", () => {
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
    if (items.filter((i) => i.status === "running").length <= 2)
      expect(after.length).toBeLessThanOrEqual(2);
    const writers = after.filter((i) => caps(i.ownerRole).writer);
    const pickedWriters = picked.filter((i) => caps(i.ownerRole).writer);
    for (const p of pickedWriters)
      expect(
        writers.filter((w) => w !== p && (w.location === p.location || !w.location || !p.location)),
      ).toEqual([]);
  }
});

test("a waiting_user item still holds its location (writer lock) and role slot, but not a thread slot", () => {
  const items = [
    it("w", "waiting_user", "dev", "repo1"),
    it("b", "ready", "dev", "repo1"),
    it("c", "ready", "one"),
  ];
  expect(ids(pickDispatchable(items, caps))).toEqual(["c"]);
  const lim = [it("w", "waiting_user", "one"), it("x", "ready", "one")];
  expect(pickDispatchable(lim, caps)).toEqual([]);
});
