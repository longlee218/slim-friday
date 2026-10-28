import { expect, test } from "bun:test";
import type { ComputerProvider, ComputerProviderPlugin } from "@friday/core";
import { COMPUTER_PLUGINS, computerProvider, computerSlots } from "../src/computer-plugins";

const log = { warn() {}, info() {} };
const env = { PATH: "/opt/bin:/usr/bin", HOME: "/home/owner", SECRET: "x" };

/** A provider whose capacity is `cap` (or throws when `cap` is an Error). */
const providerWith = (cap: { cpus: number; memoryMb: number } | Error): ComputerProvider =>
  ({
    capacity: async () => {
      if (cap instanceof Error) throw cap;
      return cap;
    },
  }) as unknown as ComputerProvider;

/** A plugin that records the raw options it was given. */
function fakePlugin(problems: string[] = []) {
  const seen: Record<string, unknown>[] = [];
  const plugin: ComputerProviderPlugin<Record<string, unknown>> = {
    id: "fake",
    parseOptions: (raw) => {
      seen.push(raw);
      return raw;
    },
    check: () => problems,
    create: () => providerWith({ cpus: 4, memoryMb: 8192 }),
  };
  return { plugin: plugin as ComputerProviderPlugin, seen };
}

test("cua is a shipped computer plugin", () => {
  expect(COMPUTER_PLUGINS.map((p) => p.id)).toContain("cua");
});

test("an unknown provider id is a problem and gives no provider", () => {
  const r = computerProvider({ provider: { id: "nope" } }, { log, env }, []);
  expect(r.provider).toBeUndefined();
  expect(r.problems).toEqual(['computer provider "nope" has no plugin']);
});

test("no computer block: no provider and a readable problem", () => {
  const r = computerProvider(undefined, { log, env });
  expect(r.provider).toBeUndefined();
  expect(r.problems[0]).toContain("settings.yaml");
});

test("the plugin gets the owner's PATH and HOME (and no other env) unless the settings name env", () => {
  const { plugin, seen } = fakePlugin();
  const r = computerProvider({ provider: { id: "fake", binary: "/b" } }, { log, env }, [plugin]);
  expect(r.provider).toBeDefined();
  expect(seen[0]).toEqual({ binary: "/b", env: { PATH: env.PATH, HOME: env.HOME } });
  const own = { PATH: "/x", HOME: "/y" };
  computerProvider({ provider: { id: "fake", env: own } }, { log, env }, [plugin]);
  expect(seen[1]).toEqual({ env: own });
});

test("failed checks and bad options are problems, not a crash", () => {
  const bad = fakePlugin(["fake: binary not found"]);
  expect(computerProvider({ provider: { id: "fake" } }, { log, env }, [bad.plugin])).toEqual({
    problems: ["fake: binary not found"],
  });
  const throwing = {
    ...bad.plugin,
    parseOptions: () => {
      throw new Error("fake: binary is required");
    },
  };
  expect(computerProvider({ provider: { id: "fake" } }, { log, env }, [throwing]).problems).toEqual(
    ["fake: binary is required"],
  );
});

test("slots come from the capacity and the settings; a capacity failure is 0 slots with the reason", async () => {
  const settings = { provider: { id: "fake" }, slots: 1, perBotCpus: 1, perBotMemoryMb: 1024 };
  const ok = await computerSlots(providerWith({ cpus: 4, memoryMb: 8192 }), settings);
  expect(ok).toMatchObject({ slots: 1, limitedBy: "setting" });
  const down = await computerSlots(providerWith(new Error("docker is not running")), settings);
  expect(down.slots).toBe(0);
  expect(down.text).toContain("docker is not running");
});
