import { expect, test } from "bun:test";
import { HONCHO_API_KEY_ENV, honchoPlugin } from "../src/honcho-plugin";
import { fakeHoncho } from "./fake-honcho";

test("options: baseUrl required, workspace optional, unknown keys refused", () => {
  expect(honchoPlugin.parseOptions({ baseUrl: "http://localhost:8000" })).toEqual({
    baseUrl: "http://localhost:8000",
    workspace: "friday",
  });
  expect(
    honchoPlugin.parseOptions({ baseUrl: "https://h.example", workspace: "home-1" }).workspace,
  ).toBe("home-1");
  for (const bad of [
    {},
    { baseUrl: 3 },
    { baseUrl: "x", extra: 1 },
    { baseUrl: "x", workspace: "a b" },
  ])
    expect(() => honchoPlugin.parseOptions(bad)).toThrow();
});

test("check: a bad URL and a public host without a key are problems; a local one needs no key", () => {
  const p = honchoPlugin;
  expect(p.check(p.parseOptions({ baseUrl: "http://localhost:8000" }), {})).toEqual([]);
  expect(p.check(p.parseOptions({ baseUrl: "http://example.com" }), {})[0]).toContain("plain http");
  expect(p.check(p.parseOptions({ baseUrl: "https://h.example" }), {})[0]).toContain(
    HONCHO_API_KEY_ENV,
  );
  expect(
    p.check(p.parseOptions({ baseUrl: "https://h.example" }), { [HONCHO_API_KEY_ENV]: "k" }),
  ).toEqual([]);
  expect(p.secretEnv).toEqual([HONCHO_API_KEY_ENV]);
});

test("create gives a honcho source that uses the key and the workspace", async () => {
  const h = fakeHoncho();
  const seen: string[] = [];
  const fetchFn = (async (u: string | URL, init?: RequestInit) => {
    seen.push(
      `${(init?.headers as Record<string, string>)?.Authorization} ${new URL(String(u)).pathname}`,
    );
    return h.fetch(u, init);
  }) as typeof fetch;
  const s = honchoPlugin.create(
    honchoPlugin.parseOptions({ baseUrl: "https://h.example", workspace: "home" }),
    { [HONCHO_API_KEY_ENV]: "k" },
    { log: { warn() {} }, fetch: fetchFn },
  );
  expect(s.id).toBe("honcho");
  await s.search({
    owner: { kind: "bot", botId: "a" },
    text: "docker",
    limit: 3,
    signal: new AbortController().signal,
  });
  expect(seen.at(-1)).toBe("Bearer k /v3/workspaces/home/conclusions/query");
});
