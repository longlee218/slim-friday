import { expect, test } from "bun:test";
import type { MemoryOwner, RecallHit, RecallSource } from "@friday/core";
import { builtinSource } from "../src/memory/recall/builtin-source";
import { MemoryRecall } from "../src/memory/recall/memory-recall";
import { fuse } from "../src/memory/recall/rrf";
import { FakeIndexStore } from "./fake-index-store";

const ann: MemoryOwner = { kind: "bot", botId: "ann" };
const hit = (ref: string, text = ref, source = "s"): RecallHit => ({
  source,
  where: "memory",
  ref,
  text,
  score: 1,
});
const source = (id: string, search: RecallSource["search"]): RecallSource => ({ id, search });

test("fuse: an item high in two lists beats one first in a single list", () => {
  const out = fuse(
    [
      [hit("a"), hit("b")],
      [hit("c"), hit("b")],
    ],
    5,
  );
  expect(out.map((h) => h.ref)).toEqual(["b", "a", "c"]);
  expect(out[0]?.score).toBeCloseTo(1 / 62 + 1 / 62);
});

test("fuse caps at limit and keeps first-list order on a tie", () => {
  expect(fuse([[hit("a"), hit("b"), hit("c")]], 2).map((h) => h.ref)).toEqual(["a", "b"]);
  expect(fuse([[hit("a")], [hit("z")]], 5).map((h) => h.ref)).toEqual(["a", "z"]);
});

test("builtinSource labels memory hits 'memory' and journal hits with their day", async () => {
  const store = new FakeIndexStore();
  store.upsertDoc(ann, "memory", "h", [{ ref: "m", path: "MEMORY.md", text: "docker compose" }]);
  store.upsertDoc(ann, "journal/2026-10-20", "j", [
    { ref: "j", path: "journal/2026-10-20.md", at: "2026-10-20", text: "docker slim" },
  ]);
  const hits = await builtinSource(store).search({
    owner: ann,
    text: "docker",
    limit: 5,
    signal: new AbortController().signal,
  });
  expect(hits.map((h) => [h.source, h.where]).sort()).toEqual([
    ["builtin", "2026-10-20"],
    ["builtin", "memory"],
  ]);
});

test("a source that throws is skipped and the other still answers", async () => {
  const warned: string[] = [];
  const recall = new MemoryRecall(
    [
      source("bad", async () => {
        throw new Error("boom");
      }),
      source("good", async () => [hit("a")]),
    ],
    { log: { warn: (_o, msg) => void warned.push(msg) } },
  );
  expect((await recall.search(ann, "docker")).map((h) => h.ref)).toEqual(["a"]);
  expect(warned).toEqual(["memory.recall"]);
});

test("a source that never resolves is cut by the timeout", async () => {
  const recall = new MemoryRecall(
    [
      source("slow", () => new Promise<RecallHit[]>(() => {})),
      source("good", async () => [hit("a")]),
    ],
    { timeoutMs: 20 },
  );
  const started = Date.now();
  expect((await recall.search(ann, "docker")).map((h) => h.ref)).toEqual(["a"]);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("search with no sources or a blank text returns []", async () => {
  expect(await new MemoryRecall([]).search(ann, "docker")).toEqual([]);
  let called = false;
  const s = source("s", async () => {
    called = true;
    return [hit("a")];
  });
  expect(await new MemoryRecall([s]).search(ann, "   ")).toEqual([]);
  expect(called).toBe(false);
});
