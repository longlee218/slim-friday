import { expect, test } from "bun:test";
import type { MemoryOwner, RecallSource } from "@friday/core";
import type { MemoryBullet } from "../src/memory/file-memory";
import { liveNotesOnly } from "../src/memory/recall/live-notes-only";

const ann: MemoryOwner = { kind: "bot", botId: "ann" };
const hit = (text: string) => ({ source: "p", where: "p", ref: text, text, score: 1 });

test("a provider hit whose text is no longer a note of the owner is dropped", async () => {
  const calls: string[] = [];
  const provider: RecallSource = {
    id: "p",
    search: async () => [hit("uses docker"), hit("deleted note")],
    write: async (_o, n) => {
      calls.push(`write ${n.text}`);
    },
    forget: async (_o, t) => {
      calls.push(`forget ${t}`);
    },
  };
  const bullets: MemoryBullet[] = [{ id: "1", kind: "fact", text: "uses docker" }];
  const s = liveNotesOnly(provider, { listBullets: () => bullets });
  const found = await s.search({
    owner: ann,
    text: "docker",
    limit: 5,
    signal: AbortSignal.timeout(1000),
  });
  expect(found.map((h) => h.text)).toEqual(["uses docker"]);
  await s.write?.(ann, { text: "x", kind: "fact" });
  await s.forget?.(ann, "y");
  expect(calls).toEqual(["write x", "forget y"]);
  expect(s.id).toBe("p");
});
