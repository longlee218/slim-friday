import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MemoryOwner,
  PermanentSourceError,
  type RecallNote,
  type RecallSource,
} from "@friday/core";
import { MemoryError } from "../src/memory/file-memory";
import { WriteThroughMemory } from "../src/memory/write-through-memory";

const ann: MemoryOwner = { kind: "bot", botId: "ann" };

/** A source that records writes and forgets; `fail` makes both throw. */
function recorder(fail = false) {
  const log: string[] = [];
  const source: RecallSource = {
    id: "rec",
    search: async () => [],
    write: async (_o, n: RecallNote) => {
      if (fail) throw new Error("down");
      log.push(`write ${n.kind} ${n.text}`);
    },
    forget: async (_o, text) => {
      if (fail) throw new Error("down");
      log.push(`forget ${text}`);
    },
  };
  return { source, log };
}

function make(
  sources: RecallSource[],
  retry: { retryDelaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "wt-"));
  const warns: string[] = [];
  const mem = new WriteThroughMemory(root, sources, {
    log: { warn: (_o, m) => void warns.push(m) },
    sleep: async () => {},
    ...retry,
  });
  return { root, mem, warns };
}

/** A source whose first `failures` calls throw `err`, then succeeds; `calls` counts every try. */
function flaky(failures: number, err: Error = new Error("down")) {
  const log: string[] = [];
  let calls = 0;
  const hit = () => {
    calls++;
    if (calls <= failures) throw err;
  };
  const source: RecallSource = {
    id: "flaky",
    search: async () => [],
    write: async (_o, n) => {
      hit();
      log.push(`write ${n.text}`);
    },
    forget: async (_o, t) => {
      hit();
      log.push(`forget ${t}`);
    },
  };
  return { source, log, calls: () => calls };
}

test("a save reaches the file and every writable source", async () => {
  const a = recorder();
  const readOnly: RecallSource = { id: "ro", search: async () => [] };
  const { root, mem } = make([a.source, readOnly]);
  await mem.save(ann, "  deploy uses <b>docker</b> ", "decision");
  await mem.flush();
  expect(readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8")).toContain("deploy uses");
  expect(a.log).toHaveLength(1);
  expect(a.log[0]).toStartWith("write decision deploy uses");
  expect(a.log[0]).not.toContain("<b>");
});

test("a throwing source does not fail the save and is logged", async () => {
  const { root, mem, warns } = make([recorder(true).source]);
  await mem.save(ann, "still saved");
  await mem.flush();
  expect(readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8")).toContain("still saved");
  expect(warns).toEqual(["memory.provider"]);
});

test("delete forgets the old text; replace forgets the old and writes the new with the same kind", async () => {
  const a = recorder();
  const { mem } = make([a.source]);
  await mem.save(ann, "uses npm", "preference");
  await mem.save(ann, "old fact");
  const [pref, fact] = mem.listBullets(ann);
  await mem.edit(ann, pref?.id ?? "", "uses bun");
  await mem.edit(ann, fact?.id ?? "", null);
  await mem.flush();
  expect(a.log.slice(2)).toEqual([
    "forget uses npm",
    "write preference uses bun",
    "forget old fact",
  ]);
});

test("a duplicate save writes nothing", async () => {
  const a = recorder();
  const { mem } = make([a.source]);
  await mem.save(ann, "uses bun");
  await expect(mem.save(ann, "uses bun")).rejects.toBeInstanceOf(MemoryError);
  await mem.flush();
  expect(a.log).toEqual(["write fact uses bun"]);
});

test("a transient failure is retried after the next delay and then lands, with no warning", async () => {
  const waits: number[] = [];
  const f = flaky(2);
  const { mem, warns } = make([f.source], {
    retryDelaysMs: [1000, 5000, 30000],
    sleep: async (ms) => void waits.push(ms),
  });
  await mem.save(ann, "retry me");
  await mem.flush();
  expect(f.calls()).toBe(3);
  expect(waits).toEqual([1000, 5000]);
  expect(f.log).toHaveLength(1);
  expect(warns).toEqual([]);
});

test("after the last delay the call is given up with one warning, and the next call still runs in order", async () => {
  const f = flaky(4);
  const { mem, warns } = make([f.source], { retryDelaysMs: [1, 5, 30] });
  await mem.save(ann, "first note");
  await mem.save(ann, "second note");
  await mem.flush();
  expect(warns).toEqual(["memory.provider"]);
  expect(f.calls()).toBe(5); // 4 tries of the first, 1 of the second
  expect(f.log).toEqual(["write second note"]);
});

test("a permanent failure is not retried", async () => {
  const f = flaky(1, new PermanentSourceError("bad request"));
  const { mem, warns } = make([f.source], { retryDelaysMs: [1, 5, 30] });
  await mem.save(ann, "rejected");
  await mem.flush();
  expect(f.calls()).toBe(1);
  expect(warns).toEqual(["memory.provider"]);
});

test("stop() cuts a pending wait short and gives up the rest", async () => {
  const f = flaky(99);
  const { mem, warns } = make([f.source], {
    retryDelaysMs: [60_000, 60_000],
    sleep: () => new Promise(() => {}),
  });
  await mem.save(ann, "never delivered");
  const done = await Promise.race([
    mem.stop().then(() => "stopped"),
    new Promise((r) => setTimeout(() => r("hung"), 500)),
  ]);
  expect(done).toBe("stopped");
  expect(warns).toEqual(["memory.provider"]);
});
