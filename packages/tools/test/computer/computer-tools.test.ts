import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseToolsFile } from "@friday/config";
import { takeControl } from "@friday/core";
import { FakeClock } from "../../../core/test/fakes/fake-clock";
import { fakeComputerHolds } from "../../../core/test/fakes/fake-computer-holds";
import type { BrowserSession } from "../../src/computer/browser/browser-session";
import type { ComputerContext } from "../../src/computer/computer-context";
import { createComputerSession } from "../../src/computer/computer-session";
import { createBrowserActTool } from "../../src/computer/tools/BrowserActTool/browser-act-tool";
import { BROWSER_ACT_TOOL } from "../../src/computer/tools/BrowserActTool/constants";
import { createBrowserNavigateTool } from "../../src/computer/tools/BrowserNavigateTool/browser-navigate-tool";
import { BROWSER_NAVIGATE_TOOL } from "../../src/computer/tools/BrowserNavigateTool/constants";
import { BROWSER_SNAPSHOT_TOOL } from "../../src/computer/tools/BrowserSnapshotTool/constants";
import { createComputerActTool } from "../../src/computer/tools/ComputerActTool/computer-act-tool";
import { COMPUTER_ACT_TOOL } from "../../src/computer/tools/ComputerActTool/constants";
import { createComputerScreenshotTool } from "../../src/computer/tools/ComputerScreenshotTool/computer-screenshot-tool";
import { COMPUTER_SCREENSHOT_TOOL } from "../../src/computer/tools/ComputerScreenshotTool/constants";
import { createComputerShellTool } from "../../src/computer/tools/ComputerShellTool/computer-shell-tool";
import { COMPUTER_SHELL_TOOL } from "../../src/computer/tools/ComputerShellTool/constants";
import { COMPUTER_MCP_SERVER } from "../../src/mcp-server-names";

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const call = (t: { handler: (a: never, e: unknown) => Promise<unknown> }, args: object) =>
  t.handler(args as never, {}) as Promise<Result>;
const textOf = (r: Result) => r.content.map((c) => c.text ?? "").join("\n");

/** Shared world: one computer, one holds store, one clock; `log` records provider and browser calls. */
function world(slotLimit = 2) {
  const clock = new FakeClock(1000);
  const holds = fakeComputerHolds();
  const log: string[] = [];
  let png: Uint8Array = new Uint8Array([1, 2, 3]);
  const provider = {
    ensure: async () => void log.push("provider.ensure"),
    exec: async (_n: string, argv: string[], t: number) => {
      log.push(`exec:${argv.join(" ")}:${t}`);
      return { code: 0, stdout: "out", stderr: "" };
    },
    screenshot: async () => ({ png, width: 1, height: 1 }),
    act: async (_n: string, a: { kind: string }) => void log.push(`act:${a.kind}`),
  };
  const make = (botId: string, browser: Partial<BrowserSession> = {}, over = {}) => {
    const ctx: ComputerContext = {
      botId,
      holder: `h-${botId}`,
      computer: { name: "box", cpus: 1, memoryMb: 512 },
      provider: provider as never,
      holds,
      clock,
      sleep: async () => clock.advance(250),
      slotLimit: () => slotLimit,
      slotsText: () => "0 of 0 slots",
      browser: {
        ensure: async () => void log.push("browser.ensure"),
        navigate: async (u: string) => `at ${u}`,
        snapshot: async () => "snap",
        act: async () => "ok",
        ...browser,
      } as never,
      ...over,
    };
    return createComputerSession(ctx);
  };
  return { clock, holds, log, make, setPng: (p: Uint8Array) => (png = p) };
}

test("tool refuses when no slot exists", async () => {
  const w = world(0);
  const r = await call(createComputerShellTool(w.make("ann")), { command: ["ls"] });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("0 of 0 slots");
  expect(w.log).toEqual([]);
});

test("ComputerAct refuses 21 actions and accepts 20", async () => {
  const w = world();
  const tool = createComputerActTool(w.make("ann"));
  const wait = { kind: "wait", ms: 1 };
  const bad = await call(tool, { actions: Array(21).fill(wait) });
  expect(bad.isError).toBe(true);
  expect(textOf(bad)).toContain("1 to 20");
  expect((await call(tool, { actions: Array(20).fill(wait) })).isError).toBeUndefined();
  expect(w.log.filter((l) => l === "act:wait")).toHaveLength(20);
});

test("two BrowserAct for two bots on one computer run one after the other", async () => {
  const w = world();
  const order: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const mk = (id: string, wait: boolean) =>
    createBrowserActTool(
      w.make(id, {
        act: async () => {
          order.push(`${id}:start`);
          if (wait) await gate;
          order.push(`${id}:end`);
          return "ok";
        },
      }),
    );
  const step = { kind: "key", keys: "Enter" };
  const a = call(mk("ann", true), { steps: [step] });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const b = call(mk("bob", false), { steps: [step] });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(order).toEqual(["ann:start"]);
  release();
  await Promise.all([a, b]);
  expect(order).toEqual(["ann:start", "ann:end", "bob:start", "bob:end"]);
});

test("identical screenshot returns the unchanged text, a changed one an image", async () => {
  const w = world();
  const tool = createComputerScreenshotTool(w.make("ann"));
  const first = await call(tool, {});
  expect(first.content[0]?.type).toBe("image");
  expect(textOf(await call(tool, {}))).toBe("Screen unchanged since the last screenshot.");
  w.setPng(new Uint8Array([9]));
  expect((await call(tool, {})).content[0]?.type).toBe("image");
});

/** Expire the input lease and give it to another bot. */
async function stealLease(w: ReturnType<typeof world>) {
  w.clock.advance(31_000);
  await w.holds.acquire({
    kind: "input",
    computer: "box",
    botId: "bob",
    holder: "h-bob",
    ttlMs: 30_000,
    now: w.clock.now(),
  });
}

const FIVE_WAITS = { actions: Array(5).fill({ kind: "wait", ms: 1 }) };

test("a lease lost at action 3 of 5 stops the batch and reports the progress", async () => {
  const w = world();
  const s = w.make("ann");
  const orig = s.ctx.provider.act;
  let n = 0;
  s.ctx.provider.act = async (name, a) => {
    await orig(name, a);
    if (++n === 2) await stealLease(w);
  };
  const r = await call(createComputerActTool(s), FIVE_WAITS);
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("lease lost after 2 of 5");
  expect(n).toBe(2);
});

test("a provider error mid-batch reports the progress", async () => {
  const w = world();
  const s = w.make("ann");
  let n = 0;
  s.ctx.provider.act = async () => {
    if (++n === 3) throw new Error("xdotool failed");
  };
  const r = await call(createComputerActTool(s), FIVE_WAITS);
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("xdotool failed after 2 of 5");
});

test("BrowserAct makes one act call and passes the lease check as beforeStep", async () => {
  const w = world();
  let calls = 0;
  const tool = createBrowserActTool(
    w.make("ann", {
      act: async (_steps: unknown, before?: () => Promise<void>) => {
        calls++;
        await before?.();
        await stealLease(w);
        await before?.().catch((e: Error) => {
          throw new Error(`${e.message} after 1 of 3 steps`);
        });
        return "ok";
      },
    } as never),
  );
  const step = { kind: "key", keys: "a" };
  const r = await call(tool, { steps: [step, step, step] });
  expect(calls).toBe(1);
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("lease lost after 1 of 3 steps");
});

test("parallel first calls start the machine and browser once", async () => {
  const w = world();
  const tool = createComputerShellTool(w.make("ann"));
  const [a, b] = await Promise.all([
    call(tool, { command: ["ls"] }),
    call(tool, { command: ["ls"] }),
  ]);
  expect(a.isError).toBeUndefined();
  expect(b.isError).toBeUndefined();
  expect(w.log.filter((l) => l === "provider.ensure")).toHaveLength(1);
  expect(w.log.filter((l) => l === "browser.ensure")).toHaveLength(1);
  expect(await w.holds.live(w.clock.now())).toHaveLength(1);
});

test("a failing start gives both callers an error and releases the slot once", async () => {
  const w = world();
  let ensures = 0;
  const tool = createComputerShellTool(
    w.make("ann", {
      ensure: async () => {
        ensures++;
        throw new Error("chromium did not start");
      },
    }),
  );
  const [a, b] = await Promise.all([
    call(tool, { command: ["ls"] }),
    call(tool, { command: ["ls"] }),
  ]);
  expect(textOf(a)).toContain("chromium did not start");
  expect(textOf(b)).toContain("chromium did not start");
  expect(ensures).toBe(1);
  expect(await w.holds.live(w.clock.now())).toHaveLength(0);
});

test("a lost slot gives a readable error, then the next call re-acquires", async () => {
  const w = world();
  const tool = createComputerShellTool(w.make("ann"));
  expect((await call(tool, { command: ["ls"] })).isError).toBeUndefined();
  const [hold] = await w.holds.live(w.clock.now());
  await w.holds.release({ key: hold!.key, holder: hold!.holder, fence: hold!.fence });
  const lost = await call(tool, { command: ["ls"] });
  expect(lost.isError).toBe(true);
  expect(textOf(lost)).toContain("slot was lost");
  expect((await call(tool, { command: ["ls"] })).isError).toBeUndefined();
});

test("ComputerShell uses the default timeout and refuses more than 120 000 ms", async () => {
  const w = world();
  const tool = createComputerShellTool(w.make("ann"));
  expect(textOf(await call(tool, { command: ["echo", "hi"] }))).toContain("out");
  expect(w.log).toContain("exec:echo hi:30000");
  const bad = await call(tool, { command: ["ls"], timeoutMs: 120_001 });
  expect(bad.isError).toBe(true);
  expect(textOf(bad)).toContain("120000");
  expect((await call(tool, { command: [] })).isError).toBe(true);
});

test("every tool name is a constant listed in tools.yaml with inComputer, and no other tool has it", async () => {
  const yaml = await Bun.file(join(import.meta.dir, "../../../config/defaults/tools.yaml")).text();
  const specs = parseToolsFile(yaml);
  const names = [
    COMPUTER_SCREENSHOT_TOOL,
    COMPUTER_ACT_TOOL,
    COMPUTER_SHELL_TOOL,
    BROWSER_NAVIGATE_TOOL,
    BROWSER_SNAPSHOT_TOOL,
    BROWSER_ACT_TOOL,
  ].map((n) => `mcp__${COMPUTER_MCP_SERVER}__${n}`);
  for (const n of names) expect(specs.find((s) => s.name === n)?.inComputer).toBe(true);
  const flagged = specs.filter((s) => s.inComputer).map((s) => s.name);
  expect(flagged.sort()).toEqual([...names].sort());
});

test("BrowserNavigate is refused while the owner controls the computer", async () => {
  const w = world();
  await takeControl({ holds: w.holds, clock: w.clock, sleep: async () => {} }, "box");
  const r = await call(createBrowserNavigateTool(w.make("ann")), { url: "https://example.com" });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("the owner is controlling");
});

test("BrowserAct marks a settled failure as an error too (the step did not run)", async () => {
  const w = world();
  const report =
    "failed 1. click p1:0: ref p1:0 is gone from the page\ndone 0 of 1; uncertain: false";
  const tool = createBrowserActTool(w.make("ann", { act: async () => report }));
  const r = await call(tool, { steps: [{ kind: "click", ref: "p1:0" }] });
  expect(r.isError).toBe(true);
});
