import { expect, test } from "bun:test";
import { loadConfig } from "../src/config/agent-config";
import { isChildEnvDenied } from "../src/config/child-env-deny";
import { VIEWER_LINK_TTL_DEFAULT_MS } from "../src/config/viewer-config";

const base = { AGENT_HOME: "/tmp/x" };

test("viewer is off without secret AND base url", () => {
  expect(loadConfig(base).viewer).toBeUndefined();
  expect(loadConfig({ ...base, VIEWER_SECRET: "s".repeat(32) }).viewer).toBeUndefined();
  expect(loadConfig({ ...base, VIEWER_BASE_URL: "https://v.example.com" }).viewer).toBeUndefined();
  expect(
    loadConfig({ ...base, VIEWER_SECRET: "REPLACE_ME", VIEWER_BASE_URL: "REPLACE_ME" }).viewer,
  ).toBeUndefined();
});

test("viewer is on with defaults: port 8787, ttl 7 d, trailing slash cut", () => {
  const v = loadConfig({
    ...base,
    VIEWER_SECRET: "s".repeat(32),
    VIEWER_BASE_URL: "https://v.example.com/",
  }).viewer;
  expect(v).toEqual({
    port: 8787,
    baseUrl: "https://v.example.com",
    secret: "s".repeat(32),
    linkTtlMs: VIEWER_LINK_TTL_DEFAULT_MS,
  });
});

test("a short secret, a bad url or a bad port refuses the start (names only)", () => {
  const ok = { ...base, VIEWER_SECRET: "s".repeat(32), VIEWER_BASE_URL: "https://v.example.com" };
  expect(() => loadConfig({ ...ok, VIEWER_SECRET: "short" })).toThrow(/VIEWER_SECRET/);
  expect(() => loadConfig({ ...ok, VIEWER_BASE_URL: "javascript:1" })).toThrow(/VIEWER_BASE_URL/);
  expect(() => loadConfig({ ...ok, VIEWER_PORT: "70000" })).toThrow(/VIEWER_PORT/);
  expect(
    loadConfig({ ...ok, VIEWER_PORT: "9000", VIEWER_LINK_TTL_MS: "1000" }).viewer,
  ).toMatchObject({
    port: 9000,
    linkTtlMs: 1000,
  });
});

test("every viewer variable is kept from agent processes", () => {
  for (const k of ["VIEWER_PORT", "VIEWER_BASE_URL", "VIEWER_SECRET", "VIEWER_LINK_TTL_MS"])
    expect(isChildEnvDenied(k)).toBe(true);
});
