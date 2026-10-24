import { expect, test } from "bun:test";
import {
  createConclusions,
  deleteConclusion,
  ensurePeers,
  type HonchoConnection,
  honchoId,
  queryConclusions,
  truncateUtf8,
} from "../src/honcho-client";
import { checkHonchoUrl } from "../src/honcho-url";

/** A fake fetch that records requests and answers with `reply(url, init)`. */
function fakeFetch(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body?: unknown }[] = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      init,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return reply(String(url), init);
  }) as typeof fetch;
  return { fn, calls };
}
const conn = (fetch: typeof globalThis.fetch, apiKey?: string): HonchoConnection => ({
  baseUrl: "http://localhost:8000/",
  ...(apiKey && { apiKey }),
  fetch,
});
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

test("ensurePeers creates the workspace then each peer once, with the bearer key", async () => {
  const f = fakeFetch(() => json({}));
  expect(await ensurePeers(conn(f.fn, "k"), "friday", ["bot-a", "bot-a", "friday-owner"])).toEqual({
    ok: true,
    value: undefined,
  });
  expect(f.calls.map((c) => c.url)).toEqual([
    "http://localhost:8000/v3/workspaces",
    "http://localhost:8000/v3/workspaces/friday/peers",
    "http://localhost:8000/v3/workspaces/friday/peers",
  ]);
  expect(f.calls[0]?.body).toEqual({ id: "friday" });
  expect(((f.calls[0]?.init.headers ?? {}) as Record<string, string>).Authorization).toBe(
    "Bearer k",
  );
  expect(f.calls.every((c) => c.init.redirect === "error")).toBe(true);
});

test("no key means no Authorization header", async () => {
  const f = fakeFetch(() => json({}));
  await ensurePeers(conn(f.fn), "friday", []);
  expect(
    ((f.calls[0]?.init.headers ?? {}) as Record<string, string>).Authorization,
  ).toBeUndefined();
});

test("createConclusions sends snake_case fields with content cut to 8192 bytes", async () => {
  const f = fakeFetch(() => json([]));
  const long = "ể".repeat(5000); // 3 bytes each
  await createConclusions(conn(f.fn), "friday", [
    { content: long, observerId: "bot-a", observedId: "friday-owner" },
  ]);
  const sent = (
    (f.calls[0]?.body ?? { conclusions: [] }) as {
      conclusions: { content: string; observer_id: string; observed_id: string }[];
    }
  ).conclusions[0];
  expect(sent?.observer_id).toBe("bot-a");
  expect(sent?.observed_id).toBe("friday-owner");
  expect(new TextEncoder().encode(sent?.content).length).toBeLessThanOrEqual(8192);
  expect(sent?.content.endsWith("ể")).toBe(true);
});

test("queryConclusions clamps top_k, filters by observer and observed, parses the list", async () => {
  const f = fakeFetch(() =>
    json([
      {
        id: "c1",
        content: "deploy uses docker",
        observer_id: "bot-a",
        observed_id: "friday-owner",
      },
    ]),
  );
  const r = await queryConclusions(conn(f.fn), "friday", {
    query: "docker",
    observerId: "bot-a",
    observedId: "friday-owner",
    topK: 500,
  });
  expect(f.calls[0]?.url).toBe("http://localhost:8000/v3/workspaces/friday/conclusions/query");
  expect(f.calls[0]?.body).toEqual({
    query: "docker",
    top_k: 100,
    filters: { observer_id: "bot-a", observed_id: "friday-owner" },
  });
  expect(r).toEqual({
    ok: true,
    value: [
      { id: "c1", content: "deploy uses docker", observerId: "bot-a", observedId: "friday-owner" },
    ],
  });
});

test("a 500, a redirect, a network error, a 2 MB body and malformed conclusions are errors", async () => {
  const q = { query: "x", observerId: "a", observedId: "b", topK: 5 };
  const cases: (() => Response | Promise<Response>)[] = [
    () => json({}, 500),
    () => {
      throw new TypeError("redirect mode is set to error");
    },
    () => Promise.reject(new Error("ECONNREFUSED")),
    () => new Response("[" + " ".repeat(2 * 1024 * 1024) + "]"),
    () => json([{ id: "bad id!", content: 1 }]),
    () => new Response("not json"),
  ];
  for (const c of cases) {
    const r = await queryConclusions(conn(fakeFetch(c).fn), "friday", q);
    expect(r.ok).toBe(false);
  }
});

test("delete: 404 is ok, an invalid id is refused without a request", async () => {
  const f = fakeFetch(() => json({}, 404));
  expect((await deleteConclusion(conn(f.fn), "friday", "c1")).ok).toBe(true);
  expect(f.calls[0]?.init.method).toBe("delete");
  expect((await deleteConclusion(conn(f.fn), "friday", "../x")).ok).toBe(false);
  expect(f.calls).toHaveLength(1);
});

test("ids: honchoId keeps letters, digits, _ and -; truncateUtf8 never splits a character", () => {
  expect(honchoId("bot:ann/x")).toBe("bot_ann_x");
  expect(honchoId("a".repeat(600))).toHaveLength(512);
  expect(truncateUtf8("aé", 2)).toBe("a");
  expect(truncateUtf8("abc", 10)).toBe("abc");
});

test("checkHonchoUrl: https anywhere, http only to localhost or a private address", () => {
  for (const ok of [
    "https://honcho.example.com",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://10.0.0.5",
    "http://172.20.1.1",
    "http://192.168.1.2:8000",
    "http://[::1]:8000",
  ])
    expect(checkHonchoUrl(ok)).toBeUndefined();
  for (const bad of [
    "http://example.com",
    "http://8.8.8.8",
    "http://172.32.0.1",
    "http://10.evil.com",
    "http://192.168.attacker.net",
    "http://127.0.0.1.nip.io",
    "ftp://x",
    "nonsense",
    "",
  ])
    expect(checkHonchoUrl(bad)).toBeString();
});
