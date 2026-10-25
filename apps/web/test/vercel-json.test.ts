import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

type Rule = { source: string; headers: { key: string; value: string }[] };
const cfg = JSON.parse(readFileSync(resolve(__dirname, "../vercel.json"), "utf8")) as {
  rewrites: unknown;
  headers: Rule[];
};

// Headers of the rule for one source, keyed by lowercased header name.
const headersFor = (source: string): Record<string, string> =>
  Object.fromEntries(
    (cfg.headers.find((r) => r.source === source)?.headers ?? []).map((h) => [
      h.key.toLowerCase(),
      h.value,
    ]),
  );

test("vercel.json rewrites every path to the SPA", () => {
  expect(cfg.rewrites).toEqual([{ source: "/(.*)", destination: "/index.html" }]);
});

test("vercel.json sends the security headers on every path", () => {
  const h = headersFor("/(.*)");
  expect(h["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["permissions-policy"]).toBe(
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  expect(h["content-security-policy"]).toBe(
    "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
  );
  expect(JSON.stringify(cfg)).not.toMatch(/unsafe-inline|unsafe-eval/);
});

test("vercel.json never caches the service worker or index.html and caches hashed assets", () => {
  expect(headersFor("/sw.js")["cache-control"]).toBe("no-cache");
  expect(headersFor("/index.html")["cache-control"]).toBe("no-cache");
  // The shell and SPA routes (everything but /assets/) are never cached.
  expect(headersFor("/((?!assets/).*)")["cache-control"]).toBe("no-cache");
  // No path may match two rules that set Cache-Control: the assets path must not match the shell rule.
  expect(new RegExp("^/((?!assets/).*)$").test("/assets/index-abc.js")).toBe(false);
  expect(new RegExp("^/((?!assets/).*)$").test("/c/bot:friday")).toBe(true);
  expect(headersFor("/assets/(.*)")["cache-control"]).toBe("public, max-age=31536000, immutable");
});
