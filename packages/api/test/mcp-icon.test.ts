import { describe, expect, test } from "bun:test";
import { createIconCache, fetchSiteIcon, MAX_ICON_BYTES } from "../src/mcp-icon";

/** A fake `fetch` answering per url; unknown urls get a 404. */
function fakeFetch(answers: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const a = answers[url];
    return a ? a() : new Response("no", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

const png = (bytes = 4) =>
  new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } });

describe("fetchSiteIcon refuses", () => {
  test("a url that is not http or https, without a request", async () => {
    const f = fakeFetch({});
    expect(await fetchSiteIcon("file:///etc/passwd", f.fn)).toBeNull();
    expect(await fetchSiteIcon("not a url", f.fn)).toBeNull();
    expect(f.calls).toEqual([]);
  });

  test("an answer that is not an image", async () => {
    const f = fakeFetch({
      "https://mcp.example.com/favicon.ico": () =>
        new Response("<html>", { headers: { "content-type": "text/html" } }),
    });
    expect(await fetchSiteIcon("https://mcp.example.com/mcp", f.fn)).toBeNull();
  });

  test("an image over the size limit", async () => {
    const f = fakeFetch({ "https://example.com/favicon.ico": () => png(MAX_ICON_BYTES + 1) });
    expect(await fetchSiteIcon("https://example.com/mcp", f.fn)).toBeNull();
  });

  test("a server that never answers (timeout)", async () => {
    const hang = (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, fail) =>
        init?.signal?.addEventListener("abort", () => fail(new Error("aborted"))),
      )) as typeof fetch;
    expect(await fetchSiteIcon("https://slow.example.com/mcp", hang, 20)).toBeNull();
  });
});

describe("fetchSiteIcon finds", () => {
  test("the favicon of the server's own host as a data url", async () => {
    const f = fakeFetch({ "https://mcp.example.com/favicon.ico": () => png() });
    expect(await fetchSiteIcon("https://mcp.example.com/mcp", f.fn)).toBe(
      "data:image/png;base64,AAAAAA==",
    );
  });

  test("the site's favicon when the mcp subdomain has none", async () => {
    const f = fakeFetch({ "https://example.com/favicon.ico": () => png() });
    expect(await fetchSiteIcon("https://mcp.example.com/mcp", f.fn)).toBe(
      "data:image/png;base64,AAAAAA==",
    );
    expect(f.calls).toEqual([
      "https://mcp.example.com/favicon.ico",
      "https://example.com/favicon.ico",
    ]);
  });
});

describe("createIconCache", () => {
  test("asks once per server url, a miss included", async () => {
    let n = 0;
    const cache = createIconCache(async () => {
      n += 1;
      return null;
    });
    await cache.get("https://a.example.com/mcp");
    await cache.get("https://a.example.com/mcp");
    expect(n).toBe(1);
  });
});
