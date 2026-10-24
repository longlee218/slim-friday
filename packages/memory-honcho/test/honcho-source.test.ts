import { expect, test } from "bun:test";
import { type MemoryOwner, PermanentSourceError } from "@friday/core";
import { recallSourceContract } from "../../tools/test/recall-source-contract";
import { HONCHO_OBSERVED_PEER, honchoSource } from "../src/honcho-source";
import { fakeHoncho } from "./fake-honcho";

const ann: MemoryOwner = { kind: "bot", botId: "ann" };
const q = (owner: MemoryOwner, text: string) => ({
  owner,
  text,
  limit: 5,
  signal: new AbortController().signal,
});

recallSourceContract("honcho", async () => {
  const h = fakeHoncho();
  const source = honchoSource({ baseUrl: "http://localhost:8000", fetch: h.fetch });
  return {
    source,
    seed: (owner, text) => source.write?.(owner, { text, kind: "fact" }) ?? Promise.resolve(),
  };
});

test("filters always come from the query owner; peers are bot-<id> / group-<id> and friday-owner", async () => {
  const h = fakeHoncho();
  const s = honchoSource(
    { baseUrl: "http://localhost:8000", fetch: h.fetch },
    { workspace: "home" },
  );
  await s.search(q(ann, "docker"));
  await s.search(q({ kind: "group", groupId: "team" }, "docker"));
  expect(h.queries.map((x) => x.filters)).toEqual([
    { observer_id: "bot-ann", observed_id: HONCHO_OBSERVED_PEER },
    { observer_id: "group-team", observed_id: HONCHO_OBSERVED_PEER },
  ]);
  expect([...h.peers].sort()).toEqual(["bot-ann", "friday-owner", "group-team"]);
});

test("a failed ensure throws and is retried on the next call", async () => {
  const h = fakeHoncho();
  const s = honchoSource({ baseUrl: "http://localhost:8000", fetch: h.fetch });
  h.failNextPeers(1);
  await expect(s.search(q(ann, "docker"))).rejects.toThrow();
  expect(await s.search(q(ann, "docker"))).toEqual([]);
  expect(h.peers.has("bot-ann")).toBe(true);
});

test("hits carry source and where honcho, the conclusion id as ref, best first", async () => {
  const h = fakeHoncho();
  const s = honchoSource({ baseUrl: "http://localhost:8000", fetch: h.fetch });
  await s.write?.(ann, { text: "deploy uses docker compose", kind: "fact" });
  await s.write?.(ann, { text: "docker", kind: "fact" });
  const hits = await s.search(q(ann, "docker compose"));
  expect(hits[0]).toMatchObject({
    source: "honcho",
    where: "honcho",
    ref: "c1",
    text: "deploy uses docker compose",
  });
  expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1);
});

test("forget removes every verbatim copy and leaves near matches", async () => {
  const h = fakeHoncho();
  const s = honchoSource({ baseUrl: "http://localhost:8000", fetch: h.fetch });
  for (const text of ["uses bun", "uses bun", "uses bun daily"])
    await s.write?.(ann, { text, kind: "fact" });
  await s.forget?.(ann, "uses bun");
  expect(h.conclusions.map((c) => c.content)).toEqual(["uses bun daily"]);
});

test("a search that gives up does not fail a write waiting on the same peer setup", async () => {
  const h = fakeHoncho();
  const release = h.holdPeers();
  const s = honchoSource({ baseUrl: "http://localhost:8000", fetch: h.fetch });
  const ac = new AbortController();
  const searching = s.search({ owner: ann, text: "docker", limit: 5, signal: ac.signal });
  const writing = s.write?.(ann, { text: "uses docker", kind: "fact" });
  ac.abort();
  await expect(searching).rejects.toThrow();
  release();
  await writing;
  expect(h.conclusions.map((c) => c.content)).toEqual(["uses docker"]);
});

test("a rejected write throws a permanent error, an unreachable server a plain one", async () => {
  const rejecting = honchoSource({
    baseUrl: "http://localhost:8000",
    fetch: (async (url: string | URL) =>
      new URL(String(url)).pathname.endsWith("/conclusions")
        ? new Response("{}", { status: 400 })
        : new Response("{}")) as typeof fetch,
  });
  const err = await rejecting.write?.(ann, { text: "x", kind: "fact" }).catch((e) => e);
  expect(err).toBeInstanceOf(PermanentSourceError);
  const down = honchoSource({
    baseUrl: "http://localhost:8000",
    fetch: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
  });
  const err2 = await down.write?.(ann, { text: "x", kind: "fact" }).catch((e) => e);
  expect(err2).toBeInstanceOf(Error);
  expect(err2).not.toBeInstanceOf(PermanentSourceError);
});
