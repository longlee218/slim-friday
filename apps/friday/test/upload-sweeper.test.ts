import { expect, test } from "bun:test";
import type { UploadRow } from "@friday/core";
import { FakeFileStore } from "../../../packages/core/test/fakes/fake-file-store";
import { FakeStore } from "../../../packages/core/test/fakes/fake-store";
import { sweepUploads } from "../src/lifecycle/upload-sweeper";

const DAY = 86_400_000;
const NOW = 10 * DAY;

/** An upload row created `ageMs` before NOW, its object in `files`. */
async function seed(
  store: FakeStore,
  files: FakeFileStore,
  id: string,
  ageMs: number,
  state: UploadRow["state"] = "pending",
) {
  const key = `uploads/bot:ann/${id}/a.txt`;
  await files.put(key, "x", "text/plain");
  await store.uploads.insert({
    id,
    key,
    conversationId: "bot:ann",
    purpose: "chat",
    name: "a.txt",
    mimeType: "text/plain",
    size: 1,
    state,
    at: NOW - ageMs,
  });
  return key;
}

/** A log that records error messages. */
const recorder = () => {
  const errors: string[] = [];
  return {
    errors,
    log: { info() {}, warn() {}, error: (_o: object, m: string) => errors.push(m) },
  };
};

test("sweepUploads deletes pending uploads older than a day and their objects; a failed delete keeps the row", async () => {
  const store = new FakeStore();
  const files = new FakeFileStore();
  const old = await seed(store, files, "old", DAY + 1);
  const fresh = await seed(store, files, "fresh", DAY - 1);
  const used = await seed(store, files, "used", 5 * DAY, "used");
  const { log } = recorder();
  expect(await sweepUploads(store, files, NOW, log)).toBe(1);
  expect(files.deleted).toEqual([old]);
  expect(await store.uploads.get("old")).toBeUndefined();
  for (const id of ["fresh", "used"]) expect(await store.uploads.get(id)).toBeDefined();
  expect(files.objects.has(fresh) && files.objects.has(used)).toBe(true);

  // An R2 failure keeps the row and is logged; the next sweep retries it.
  await seed(store, files, "again", 2 * DAY);
  const r = recorder();
  files.failNext("delete");
  expect(await sweepUploads(store, files, NOW, r.log)).toBe(0);
  expect(await store.uploads.get("again")).toBeDefined();
  expect(r.errors).toEqual(["uploads.sweep"]);
  expect(await sweepUploads(store, files, NOW, r.log)).toBe(1);
  expect(await store.uploads.get("again")).toBeUndefined();
});

test("a claimed upload (a send in progress) is swept only after two days", async () => {
  const store = new FakeStore();
  const files = new FakeFileStore();
  await seed(store, files, "busy", DAY + 1, "claimed");
  await seed(store, files, "stale", 2 * DAY + 1, "claimed");
  expect(await sweepUploads(store, files, NOW, recorder().log)).toBe(1);
  expect(await store.uploads.get("busy")).toBeDefined();
  expect(await store.uploads.get("stale")).toBeUndefined();
});

test("an upload a send took after the list was read is kept (the row is read again before the delete)", async () => {
  const store = new FakeStore();
  const files = new FakeFileStore();
  const usedKey = await seed(store, files, "used-now", 2 * DAY);
  const claimedKey = await seed(store, files, "claimed-now", 2 * DAY);
  // The list is read while both are pending; a send then uses one and claims the other.
  const listed = await store.uploads.pendingBefore(NOW - DAY);
  await store.uploads.markUsed("used-now", 7);
  await store.uploads.claim("claimed-now");
  store.uploads.pendingBefore = async () => listed;
  expect(await sweepUploads(store, files, NOW, recorder().log)).toBe(0);
  expect(files.deleted).toEqual([]);
  expect(files.objects.has(usedKey) && files.objects.has(claimedKey)).toBe(true);
  expect(await store.uploads.get("used-now")).toBeDefined();
});
