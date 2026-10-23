import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { bootFriday } from "../src/lifecycle/boot";
import { openDb } from "../src/storage/db";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "friday-boot-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Boot, wait for ready, abort, and return how long the shutdown took (ms). */
async function bootAndStop(): Promise<number> {
  const ac = new AbortController();
  const ready = Promise.withResolvers<void>();
  const done = bootFriday({ agentHome: home, signal: ac.signal, onReady: () => ready.resolve() });
  await ready.promise;
  const t0 = Date.now();
  ac.abort();
  await done;
  return Date.now() - t0;
}

test("boots on a fresh home and stops cleanly on abort", async () => {
  expect(await bootAndStop()).toBeLessThan(5000);
});

test("boots on a db that already holds rows in the old engine tables", async () => {
  // Opening applies every migration, so the old tables exist; put a row in one of them.
  const db = openDb(workspacePaths(home).dbFile);
  db.run(
    "INSERT INTO threads (thread_id, channel_id, origin, created_at, updated_at) VALUES ('t1','c1','bot',1,1)",
  );
  db.close();
  expect(await bootAndStop()).toBeLessThan(5000);
});
