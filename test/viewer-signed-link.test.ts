import { expect, test } from "bun:test";
import { VIEWER_LINK_TTL_DEFAULT_MS, type ViewerConfig } from "../src/config/viewer-config";
import { openLinks, signedArtifactUrl, verifyLink } from "../src/viewer/signed-link";

const cfg: ViewerConfig = {
  port: 8787,
  baseUrl: "https://v.example.com",
  secret: "s".repeat(32),
  linkTtlMs: VIEWER_LINK_TTL_DEFAULT_MS,
};
const NOW = 1_800_000_000_000;

/** `e` and `s` of a signed url. */
const parts = (url: string) => {
  const u = new URL(url);
  return { path: u.pathname, e: u.searchParams.get("e"), s: u.searchParams.get("s") };
};

test("a fresh link verifies; the url has the id and no path", () => {
  const { path, e, s } = parts(signedArtifactUrl(cfg, "abc-123", NOW));
  expect(path).toBe("/a/abc-123");
  expect(Number(e)).toBe(Math.floor((NOW + VIEWER_LINK_TTL_DEFAULT_MS) / 1000));
  expect(verifyLink(cfg.secret, "abc-123", e, s, NOW)).toBe(true);
});

test("a tampered signature, id, expiry or another secret is refused", () => {
  const { e, s } = parts(signedArtifactUrl(cfg, "abc", NOW));
  const flipped = `${s!.startsWith("0") ? "1" : "0"}${s!.slice(1)}`;
  expect(verifyLink(cfg.secret, "abc", e, flipped, NOW)).toBe(false);
  expect(verifyLink(cfg.secret, "abd", e, s, NOW)).toBe(false);
  expect(verifyLink(cfg.secret, "abc", String(Number(e) + 1), s, NOW)).toBe(false);
  expect(verifyLink("t".repeat(32), "abc", e, s, NOW)).toBe(false);
});

test("an expired link is refused (even with a valid signature); malformed input too", () => {
  const { e, s } = parts(signedArtifactUrl(cfg, "abc", NOW));
  expect(verifyLink(cfg.secret, "abc", e, s, NOW + VIEWER_LINK_TTL_DEFAULT_MS)).toBe(false);
  expect(verifyLink(cfg.secret, "abc", e, s, NOW + VIEWER_LINK_TTL_DEFAULT_MS - 2000)).toBe(true);
  for (const bad of [null, "", "x", "1e9", "-1"])
    expect(verifyLink(cfg.secret, "abc", bad, s, NOW)).toBe(false);
  for (const bad of [null, "", "abc", "z".repeat(64), s!.slice(1)])
    expect(verifyLink(cfg.secret, "abc", e, bad, NOW)).toBe(false);
});

test("openLinks: one Open button when the viewer is on and there is an artifact; none otherwise", () => {
  expect(openLinks(cfg, "abc")).toEqual([
    { label: "Open", url: expect.stringContaining("/a/abc?e=") },
  ]);
  expect(openLinks(undefined, "abc")).toEqual([]);
  expect(openLinks(cfg, null)).toEqual([]);
});
