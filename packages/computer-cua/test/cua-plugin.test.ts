import { describe, expect, test } from "bun:test";
import { makeCuaPlugin } from "../src/cua-plugin";

const probe = (exists: boolean, version: string) =>
  makeCuaPlugin({ exists: () => exists, version: () => version });

describe("cua plugin", () => {
  test("id and defaults", () => {
    const o = probe(true, "cua 0.9.0").parseOptions({ binary: "/opt/cua/bin/cua" });
    expect(o).toMatchObject({
      binary: "/opt/cua/bin/cua",
      image: "ghcr.io/trycua/linux:24.04-slim",
      version: "0.9.0",
    });
    expect(probe(true, "").id).toBe("cua");
  });
  test("parseOptions refuses a relative binary, unknown keys, missing binary", () => {
    const p = probe(true, "");
    expect(() => p.parseOptions({})).toThrow(/binary/);
    expect(() => p.parseOptions({ binary: "cua" })).toThrow(/absolute/);
    expect(() => p.parseOptions({ binary: "/a/cua", extra: 1 })).toThrow(/extra/);
  });
  test("a non-default image is refused, the default parses", () => {
    const p = probe(true, "");
    expect(() => p.parseOptions({ binary: "/a/cua", image: "foo" })).toThrow(/image/);
    expect(
      p.parseOptions({ binary: "/a/cua", image: "ghcr.io/trycua/linux:24.04-slim" }).image,
    ).toBe("ghcr.io/trycua/linux:24.04-slim");
  });
  test("check reports a missing binary", () => {
    const p = probe(false, "");
    const o = p.parseOptions({ binary: "/opt/cua/bin/cua" });
    expect(p.check(o).join()).toMatch(/not found/);
  });
  test("check reports a version mismatch", () => {
    const p = probe(true, "cua 0.8.1");
    const o = p.parseOptions({ binary: "/opt/cua/bin/cua" });
    expect(p.check(o).join()).toMatch(/0\.8\.1.*0\.9\.0/);
  });
  test("check passes on the expected version", () => {
    const p = probe(true, "cua 0.9.0\n");
    expect(p.check(p.parseOptions({ binary: "/opt/cua/bin/cua" }))).toEqual([]);
  });
});
