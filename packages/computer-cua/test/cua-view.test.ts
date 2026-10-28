import { describe, expect, test } from "bun:test";
import type { ExecResult } from "@friday/core";
import { makePortForwards } from "../src/cua-port-forward";
import { createCuaProvider } from "../src/cua-provider";
import type { CuaRun } from "../src/cua-run";

const spec = { name: "bot-1", cpus: 2, memoryMb: 1536 };
const open = { viewOnly: false };
const reply = (url: string, extra: object = {}): ExecResult => ({
  code: 0,
  stdout: JSON.stringify({ expires_at_unix: 1_800_000_600, name: "bot-1", url, ...extra }),
  stderr: "",
});

function setup(answer: ExecResult) {
  const calls: string[][] = [];
  const run: CuaRun = async (argv) => {
    calls.push(argv);
    return answer;
  };
  const docker: CuaRun = async () => ({ code: 0, stdout: "{}", stderr: "" });
  const forwards = makePortForwards(
    "/opt/cua/bin/cua",
    { PATH: "/bin", HOME: "/h" },
    {
      spawn: () => ({ kill() {}, exited: new Promise(() => {}) }),
      freePort: async () => 1,
      waitReady: async () => {},
    },
  );
  return { provider: createCuaProvider({ run, docker, forwards }), calls };
}

describe("view", () => {
  test("parses the viewer url, port and expiry", async () => {
    const url = "http://127.0.0.1:41000/viewer/#ticket=abc";
    const { provider, calls } = setup(reply(url));
    expect(await provider.view(spec, open)).toEqual({
      url,
      port: 41000,
      expiresAt: 1_800_000_600_000,
    });
    expect(calls).toEqual([["sandbox", "view", "bot-1", "--no-open", "--ttl", "10m"]]);
  });
  test("viewOnly adds --view-only before --no-open", async () => {
    const { provider, calls } = setup(reply("http://localhost:41000/viewer/#ticket=a"));
    await provider.view(spec, { viewOnly: true });
    expect(calls[0]).toEqual([
      "sandbox",
      "view",
      "bot-1",
      "--view-only",
      "--no-open",
      "--ttl",
      "10m",
    ]);
  });
  const hosts = [
    "http://10.0.0.5:41000/viewer/#t=1",
    "http://evil.com:41000/",
    "http://127.0.0.1.evil.com:1/",
    "ftp://127.0.0.1:1/",
  ];
  for (const url of hosts) {
    test(`refuses ${url}`, async () => {
      await expect(setup(reply(url)).provider.view(spec, open)).rejects.toThrow(/loopback|viewer/);
    });
  }
  test("refuses missing port, bad json and failed command", async () => {
    await expect(
      setup(reply("http://127.0.0.1/viewer/")).provider.view(spec, open),
    ).rejects.toThrow();
    await expect(
      setup({ code: 0, stdout: "nope", stderr: "" }).provider.view(spec, open),
    ).rejects.toThrow();
    await expect(
      setup({ code: 124, stdout: "", stderr: "timed out" }).provider.view(spec, open),
    ).rejects.toThrow(/124/);
  });
  test("refuses a bad computer name without running", async () => {
    const { provider, calls } = setup(reply("http://127.0.0.1:1/"));
    await expect(provider.view({ ...spec, name: "A b" }, open)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
