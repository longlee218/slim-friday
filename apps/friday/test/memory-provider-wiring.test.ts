import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryOwner } from "@friday/core";
import { FileMemory, WriteThroughMemory } from "@friday/tools";
import { FakeRuntime } from "../../../packages/core/test/fakes/fake-runtime";
import { fakeHoncho } from "../../../packages/memory-honcho/test/fake-honcho";
import { type AppDeps, type RuntimeParts, startApp } from "../src/start-app";
import { webParts } from "./web-fixture";

const ann: MemoryOwner = { kind: "bot", botId: "ann" };
const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stoppers.splice(0)) await s();
});

async function boot(home: string, extra: Partial<AppDeps> = {}) {
  let parts: RuntimeParts | undefined;
  const app = await startApp({
    ...webParts(home),
    runtime: (p) => {
      parts = p;
      return new FakeRuntime();
    },
    agentHome: home,
    log: { info() {}, warn() {}, error() {} },
    ...extra,
  });
  stoppers.push(() => app.stop());
  if (!parts) throw new Error("runtime factory not called");
  return parts;
}

const withHoncho = (home: string) => {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    join(home, "config", "settings.yaml"),
    "memory:\n  providers:\n    - { id: honcho, baseUrl: http://localhost:8000 }\n",
  );
};

test("with a honcho provider a MemorySave reaches Honcho and recall fuses builtin and honcho hits", async () => {
  const home = mkdtempSync(join(tmpdir(), "prov-"));
  withHoncho(home);
  const h = fakeHoncho();
  const parts = await boot(home, { fetch: h.fetch });
  expect(parts.memory).toBeInstanceOf(WriteThroughMemory);
  await parts.memory.save(ann, "deploy uses docker compose");
  await (parts.memory as WriteThroughMemory).flush();
  expect(h.conclusions.map((c) => c.content)).toEqual(["deploy uses docker compose"]);
  const hits = await parts.recall.search(ann, "docker compose");
  expect(new Set(hits.map((x) => x.source))).toEqual(new Set(["builtin", "honcho"]));
});

test("with no providers memory is a plain FileMemory", async () => {
  const parts = await boot(mkdtempSync(join(tmpdir(), "prov-")));
  expect(parts.memory).toBeInstanceOf(FileMemory);
  expect(parts.memory).not.toBeInstanceOf(WriteThroughMemory);
});

test("a provider problem is a config.problem and the app still starts", async () => {
  const home = mkdtempSync(join(tmpdir(), "prov-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    join(home, "config", "settings.yaml"),
    "memory:\n  providers:\n    - { id: honcho, baseUrl: http://example.com }\n",
  );
  const warns: unknown[] = [];
  let parts: RuntimeParts | undefined;
  const app = await startApp({
    ...webParts(home),
    runtime: (p) => {
      parts = p;
      return new FakeRuntime();
    },
    agentHome: home,
    log: { info() {}, warn: (o, m) => void warns.push([m, o]), error() {} },
  });
  stoppers.push(() => app.stop());
  expect(JSON.stringify(warns)).toContain("plain http");
  expect(parts?.memory).not.toBeInstanceOf(WriteThroughMemory);
});
