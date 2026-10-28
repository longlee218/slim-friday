import { describe, expect, test } from "bun:test";
import { cuaPlugin } from "../src/cua-plugin";

/* Live check against the real `cua` binary. Run: FRIDAY_LIVE_CUA=/abs/path/to/cua bun test <this file> */

const binary = process.env.FRIDAY_LIVE_CUA ?? "";
const NAME = "friday-live-test";

describe.skipIf(!binary)("cua live", () => {
  test("create, exec, screenshot, remove", async () => {
    const options = cuaPlugin.parseOptions({
      binary,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    expect(cuaPlugin.check(options)).toEqual([]);
    const log = { warn() {}, info() {} };
    const provider = cuaPlugin.create(options, { log });
    try {
      await provider.ensure({ name: NAME, cpus: 2, memoryMb: 1536 });
      const res = await provider.exec(NAME, ["uname", "-a"], 30_000);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Linux");
      const shot = await provider.screenshot(NAME);
      expect(shot.png.length).toBeGreaterThan(100);
    } finally {
      Bun.spawnSync([binary, "sandbox", "rm", "-f", NAME]);
    }
  }, 180_000);
});
