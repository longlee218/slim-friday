import { expect, spyOn, test } from "bun:test";
import type {
  Bot,
  BotRuntimeSpec,
  ComputerHold,
  ComputerProvider,
  ComputerProviderPlugin,
  Store,
} from "@friday/core";
import { BrowserSession } from "@friday/tools";
import { createComputers, PROFILE_ROOT } from "../src/computer-sessions";

const bot = (id: string, computer?: string): Bot => ({
  id,
  name: id,
  title: "",
  instructions: "",
  model: "m",
  tools: [],
  skills: [],
  subagents: [],
  workspaces: [],
  ...(computer && { computer }),
});
const specOf = (b: Bot, wakeId?: string): BotRuntimeSpec => ({
  bot: b,
  runKind: "owner",
  decide: async () => ({ behavior: "allow" }),
  sessionKey: b.id,
  ...(wakeId && { wakeId }),
});

/** A log that keeps its lines. */
function memLog() {
  const lines: { level: string; o: Record<string, unknown>; msg: string }[] = [];
  const at = (level: string) => (o: object, msg: string) =>
    void lines.push({ level, o: { ...o }, msg });
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

/** Holds like the sqlite repo: `live(now)` keeps rows with expiresAt > now; a matching release sets expiresAt 0. */
function fakeHolds(start: ComputerHold[]) {
  const rows = start.map((r) => ({ ...r }));
  const released: { key: string; holder: string; fence: number }[] = [];
  const holds = {
    live: async (now: number) => rows.filter((r) => r.expiresAt > now).map((r) => ({ ...r })),
    release: async (a: { key: string; holder: string; fence: number }) => {
      released.push(a);
      for (const r of rows)
        if (r.key === a.key && r.holder === a.holder && r.fence === a.fence) r.expiresAt = 0;
    },
  } as unknown as Store["computerHolds"];
  return { holds, released, rows };
}

const hold = (key: string, botId: string, fence: number): ComputerHold => ({
  key,
  kind: key.startsWith("slot:") ? "slot" : "input",
  computer: "home",
  botId,
  holder: `w-${botId}`,
  fence,
  expiresAt: 10_000,
});

const clock = { now: () => 0, setTimer: () => () => {} };
const env = { PATH: "/usr/bin", HOME: "/home/owner" };

/** A plugin whose provider has the given capacity. */
const plugin = (cap: { cpus: number; memoryMb: number }): ComputerProviderPlugin => ({
  id: "fake",
  parseOptions: (raw) => raw,
  check: () => [],
  create: () => ({ capacity: async () => cap }) as unknown as ComputerProvider,
});

test("two bots on computer home get their own browser port and profile dir", () => {
  const bots = [bot("ann", "home"), bot("bob", "home")];
  const c = createComputers({
    settings: undefined,
    env,
    bots: () => bots,
    holds: fakeHolds([]).holds,
    clock,
    log: memLog(),
  });
  const a = c.placement(bots[0] as Bot);
  const b = c.placement(bots[1] as Bot);
  expect(a.cdpPort).not.toBe(b.cdpPort);
  expect(a.profileDir).toBe(`${PROFILE_ROOT}/ann`);
  expect(b.profileDir).toBe(`${PROFILE_ROOT}/bob`);
});

test("no provider: the app starts, 0 slots with the problem text, and the bot still gets a refusing server", async () => {
  const log = memLog();
  const c = createComputers({
    settings: { provider: { id: "nope" } },
    env,
    bots: () => [bot("ann", "home")],
    holds: fakeHolds([]).holds,
    clock,
    log,
  });
  await c.ready;
  expect(c.slotLimit()).toBe(0);
  expect(c.slotsText()).toContain('computer provider "nope" has no plugin');
  expect(log.lines.some((l) => l.level === "warn" && l.msg === "computer.problem")).toBe(true);
  expect(c.server(specOf(bot("ann", "home")))).toBeDefined();
  expect(c.server(specOf(bot("dan")))).toBeUndefined();
});

test("slots are computed once at start and logged with their text", async () => {
  const log = memLog();
  const c = createComputers({
    settings: { provider: { id: "fake" }, slots: 2 },
    env,
    bots: () => [],
    holds: fakeHolds([]).holds,
    clock,
    log,
    plugins: [plugin({ cpus: 8, memoryMb: 16_384 })],
  });
  await c.ready;
  expect(c.slotLimit()).toBe(2);
  const logged = log.lines.filter((l) => l.msg === "computer.slots");
  expect(logged).toHaveLength(1);
  expect(logged[0]?.o).toMatchObject({ slots: 2, text: c.slotsText() });
});

test("release is per run: only the wake that holds the slot frees it and closes the browser", async () => {
  const close = spyOn(BrowserSession.prototype, "close");
  const { holds, released } = fakeHolds([
    { ...hold("slot:ann", "ann", 3), holder: "wB" },
    hold("slot:bob", "bob", 1),
    { ...hold("input:home", "ann", 7), holder: "wB" },
  ]);
  const c = createComputers({
    settings: undefined,
    env,
    bots: () => [bot("ann", "home")],
    holds,
    clock,
    log: memLog(),
  });
  // Run B built the session (a browser exists); run A of the same bot never used the computer.
  c.server(specOf(bot("ann", "home"), "wB"));
  await c.release("ann", "wA");
  expect(released).toEqual([]);
  expect(close).not.toHaveBeenCalled();
  await c.release("ann", "wB");
  expect(released).toEqual([{ key: "slot:ann", holder: "wB", fence: 3 }]);
  expect(close).toHaveBeenCalledTimes(1);
  // Twice is harmless; a bot that never used its computer is a no-op.
  await c.release("ann", "wB");
  await c.release("dan", "wX");
  expect(released).toHaveLength(1);
  expect(close).toHaveBeenCalledTimes(1);
  close.mockRestore();
});

test("a lapsed (expired, not released) slot of the run still closes the browser and releases the row", async () => {
  const close = spyOn(BrowserSession.prototype, "close");
  const { holds, released, rows } = fakeHolds([
    { ...hold("slot:ann", "ann", 3), holder: "wB", expiresAt: 5_000 },
    { ...hold("slot:bob", "bob", 1), holder: "wC", expiresAt: 5_000 },
  ]);
  const c = createComputers({
    settings: undefined,
    env,
    bots: () => [bot("ann", "home"), bot("bob", "home")],
    holds,
    clock: { now: () => 200_000, setTimer: () => () => {} },
    log: memLog(),
  });
  c.server(specOf(bot("ann", "home"), "wB"));
  await c.release("ann", "wB");
  expect(close).toHaveBeenCalledTimes(1);
  expect(released).toEqual([{ key: "slot:ann", holder: "wB", fence: 3 }]);
  expect(rows.find((r) => r.key === "slot:bob")?.expiresAt).toBe(5_000);
  close.mockRestore();
});
