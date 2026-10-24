import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BotRuntimeSpec,
  MemoryIndexStore,
  MemoryOwner,
  MessageIndexStore,
} from "@friday/core";
import { FakeRuntime } from "../../../packages/core/test/fakes/fake-runtime";
import { FakeDiscordPort } from "../../../packages/surface-discord/test/fake-discord-port";
import { memoryFlush } from "../src/memory-flush";
import { type RuntimeParts, startApp } from "../src/start-app";

const ann: MemoryOwner = { kind: "bot", botId: "ann" };
const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stoppers.splice(0)) await s();
});

/** Start the app over fakes on `home` and hand back the parts the runtime factory received. */
async function boot(
  home: string,
  opts: { memoryIndex?: MemoryIndexStore & MessageIndexStore } = {},
) {
  const errors: string[] = [];
  const log = {
    info() {},
    warn() {},
    error: (_o: object, msg: string) => void errors.push(msg),
  };
  let parts: RuntimeParts | undefined;
  const app = await startApp({
    port: new FakeDiscordPort(),
    runtime: (p) => {
      parts = p;
      return new FakeRuntime();
    },
    agentHome: home,
    log,
    ...opts,
  });
  const stop = () => app.stop();
  stoppers.push(stop);
  if (!parts) throw new Error("runtime factory not called");
  return { parts, errors, stop };
}

const seedMemory = (home: string, bullet: string) => {
  const dir = join(home, "memory", "bots", "ann");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), `## Facts\n- ${bullet} (2026-10-20)\n`);
};

test("start reconciles existing MEMORY.md and journal files into the index", async () => {
  const home = mkdtempSync(join(tmpdir(), "wire-"));
  seedMemory(home, "deploy uses docker compose");
  const jdir = join(home, "memory", "bots", "ann", "journal");
  mkdirSync(jdir, { recursive: true });
  writeFileSync(
    join(jdir, "2026-10-20.md"),
    "# Journal 2026-10-20\n\n## 09:00 Flush\n- slim image\n",
  );
  const { parts } = await boot(home);
  expect((await parts.recall.search(ann, "docker")).map((h) => h.where)).toEqual(["memory"]);
  expect((await parts.recall.search(ann, "slim")).map((h) => h.where)).toEqual(["2026-10-20"]);
});

test("a note saved through parts.memory is searchable at once", async () => {
  const home = mkdtempSync(join(tmpdir(), "wire-"));
  const { parts } = await boot(home);
  await parts.memory.save(ann, "backups run nightly");
  expect((await parts.recall.search(ann, "nightly"))[0]?.text).toContain("backups run nightly");
});

test("memoryFlush writes the journal and the notes are searchable", async () => {
  const home = mkdtempSync(join(tmpdir(), "wire-"));
  const { parts } = await boot(home);
  const spec = { bot: { id: "ann" } } as unknown as BotRuntimeSpec;
  await memoryFlush(
    join(home, "memory"),
    async () => ["owner likes jasmine tea"],
    { error() {}, warn() {} },
    parts.memoryChanged,
  )(spec, "summary");
  expect((await parts.recall.search(ann, "jasmine")).map((h) => h.where)).toHaveLength(1);
});

test("a deleted memory-index.db is rebuilt at the next start and search still works", async () => {
  const home = mkdtempSync(join(tmpdir(), "wire-"));
  seedMemory(home, "deploy uses docker compose");
  const first = await boot(home);
  await first.stop();
  const db = join(home, "data", "memory-index.db");
  expect(existsSync(db)).toBe(true);
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  const { parts } = await boot(home);
  expect(await parts.recall.search(ann, "docker")).toHaveLength(1);
});

test("an index that throws on reindex does not fail MemorySave", async () => {
  const home = mkdtempSync(join(tmpdir(), "wire-"));
  const broken: MemoryIndexStore & MessageIndexStore = {
    docHash: () => undefined,
    docIds: () => [],
    upsertDoc: () => {
      throw new Error("index down");
    },
    removeDoc() {},
    searchText: () => [],
    close() {},
    lastMessageId: () => 0,
    addMessages() {},
    searchMessages: () => [],
  };
  const { parts, errors } = await boot(home, { memoryIndex: broken });
  await parts.memory.save(ann, "still saved");
  expect(parts.memory.listBullets(ann)).toHaveLength(1);
  expect(errors).toContain("memory.index");
});
