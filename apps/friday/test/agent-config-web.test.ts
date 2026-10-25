import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/agent-config";

const base = { AGENT_HOME: "/tmp/friday-home" };
const load = (extra: Record<string, string>) => loadConfig({ ...base, ...extra });

describe("web API env vars", () => {
  test("AUTH_SECRET shorter than 32 chars is refused, naming the variable and never the value", () => {
    const secret = "s".repeat(31);
    let msg = "";
    try {
      load({ AUTH_SECRET: secret });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe("Invalid environment variables: AUTH_SECRET");
    expect(msg).not.toContain(secret);
  });

  test.each([
    "https://friday.example.com/",
    "https://friday.example.com/app",
    "friday.example.com",
  ])("WEB_ORIGIN %s is refused", (v) => {
    expect(() => load({ WEB_ORIGIN: v })).toThrow(/WEB_ORIGIN/);
  });

  test("WEB_ORIGIN lists several origins: the first is the primary, the rest are extra", () => {
    const c = load({ WEB_ORIGIN: " https://friday.example.com , http://localhost:5173 " });
    expect(c.webOrigin).toBe("https://friday.example.com");
    expect(c.extraWebOrigins).toEqual(["http://localhost:5173"]);
  });

  test("one WEB_ORIGIN has no extra origins; a duplicate is dropped", () => {
    expect(load({ WEB_ORIGIN: "https://friday.example.com" }).extraWebOrigins).toEqual([]);
    const c = load({ WEB_ORIGIN: "https://a.example.com,https://a.example.com" });
    expect(c.extraWebOrigins).toEqual([]);
  });

  test("a bad entry in the WEB_ORIGIN list is refused, naming only the variable", () => {
    expect(() => load({ WEB_ORIGIN: "https://a.example.com,http://localhost:5173/" })).toThrow(
      "Invalid environment variables: WEB_ORIGIN",
    );
    expect(() => load({ WEB_ORIGIN: "https://a.example.com,*" })).toThrow(/WEB_ORIGIN/);
  });

  test("PUBLIC_API_URL with a path is refused", () => {
    expect(() => load({ PUBLIC_API_URL: "https://api.example.com/x" })).toThrow(/PUBLIC_API_URL/);
  });

  test("OWNER_EMAIL that is not an email is refused", () => {
    expect(() => load({ OWNER_EMAIL: "not-an-email" })).toThrow(/OWNER_EMAIL/);
  });

  test.each(["0", "70000"])("API_PORT %s is refused", (v) => {
    expect(() => load({ API_PORT: v })).toThrow(/API_PORT/);
  });

  test("no web vars: apiPort defaults to 8787, the rest is undefined", () => {
    const c = load({});
    expect(c.apiPort).toBe(8787);
    expect(c.webOrigin).toBeUndefined();
    expect(c.publicApiUrl).toBeUndefined();
    expect(c.authSecret).toBeUndefined();
    expect(c.ownerEmail).toBeUndefined();
  });

  test("a full set is kept as given, ownerEmail lower-cased", () => {
    const c = load({
      API_PORT: "9000",
      WEB_ORIGIN: "https://friday.example.com",
      PUBLIC_API_URL: "https://api.example.com",
      AUTH_SECRET: "a".repeat(32),
      OWNER_EMAIL: "Owner@Example.com",
    });
    expect(c).toMatchObject({
      apiPort: 9000,
      webOrigin: "https://friday.example.com",
      publicApiUrl: "https://api.example.com",
      authSecret: "a".repeat(32),
      ownerEmail: "owner@example.com",
    });
  });
});

describe("CDN env var", () => {
  test("unset gives undefined", () => {
    expect(load({}).cdnUrl).toBeUndefined();
  });

  test("a trailing slash is stripped", () => {
    expect(load({ CDN: "https://img.example.com/" }).cdnUrl).toBe("https://img.example.com");
  });

  test.each(["http://img.example.com", "img.example.com"])("%s is refused", (v) => {
    expect(() => load({ CDN: v })).toThrow(/CDN/);
  });
});
