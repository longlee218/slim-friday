import { expect, test } from "bun:test";
import type { McpServerInput } from "@friday/core";
import { createMcpProbe } from "../src/mcp-probe";

type Status = { name: string; status: string; error?: string; tools?: { name: string }[] };

/** A scripted `query`: each `mcpServerStatus()` call answers the next status (the last one repeats). */
function fakeProbeQuery(statuses: Status[]) {
  const seen: { options?: Record<string, unknown>; interrupted: boolean; closed: boolean } = {
    interrupted: false,
    closed: false,
  };
  let i = 0;
  const queryFn = ((a: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    seen.options = a.options;
    // Drain the prompt so the test sees when the probe closes its input.
    void (async () => {
      for await (const _ of a.prompt) {
        /* never yields */
      }
      seen.closed = true;
    })();
    return {
      mcpServerStatus: async () => [statuses[Math.min(i++, statuses.length - 1)]],
      interrupt: async () => {
        seen.interrupted = true;
      },
    };
  }) as never;
  return { queryFn, seen };
}

const http: McpServerInput = { type: "http", url: "https://x.example/mcp" };

test("probe maps pending then connected, passes no-model options and always closes", async () => {
  const f = fakeProbeQuery([
    { name: "gh", status: "pending" },
    { name: "gh", status: "pending" },
    { name: "gh", status: "connected", tools: [{ name: "a" }] },
  ]);
  const probe = createMcpProbe({ env: { A: "1" }, query: f.queryFn });
  expect(await probe("gh", http)).toEqual({ status: "connected", tools: ["a"] });
  expect(f.seen.interrupted).toBe(true);
  await Bun.sleep(5);
  expect(f.seen.closed).toBe(true);
  expect(f.seen.options).toMatchObject({
    mcpServers: { gh: { type: "http", url: "https://x.example/mcp" } },
    settingSources: [],
    tools: [],
    env: { A: "1" },
  });
});

test("the probe starts the server in the given cwd", async () => {
  const f = fakeProbeQuery([{ name: "s", status: "connected", tools: [] }]);
  const probe = createMcpProbe({ env: {}, cwd: "/some/empty/dir", query: f.queryFn });
  await probe("s", http);
  expect(f.seen.options?.cwd).toBe("/some/empty/dir");
});

test("stdio input becomes a stdio SDK config", async () => {
  const f = fakeProbeQuery([{ name: "s", status: "connected", tools: [] }]);
  const probe = createMcpProbe({ env: {}, query: f.queryFn });
  await probe("s", { type: "stdio", command: "npx", args: ["-y", "x"], env: { K: "v" } });
  expect(f.seen.options?.mcpServers).toEqual({
    s: { type: "stdio", command: "npx", args: ["-y", "x"], env: { K: "v" } },
  });
});

test("needs-auth maps to needs-auth", async () => {
  const f = fakeProbeQuery([{ name: "gh", status: "needs-auth" }]);
  expect(await createMcpProbe({ env: {}, query: f.queryFn })("gh", http)).toEqual({
    status: "needs-auth",
  });
});

test("failed carries the error cut to 300 chars", async () => {
  const f = fakeProbeQuery([{ name: "gh", status: "failed", error: "x".repeat(500) }]);
  const r = await createMcpProbe({ env: {}, query: f.queryFn })("gh", http);
  expect(r).toEqual({ status: "failed", error: "x".repeat(300) });
});

test("probe times out as failed and still closes", async () => {
  const f = fakeProbeQuery([{ name: "gh", status: "pending" }]);
  const probe = createMcpProbe({ env: {}, timeoutMs: 50, query: f.queryFn });
  expect(await probe("gh", http)).toEqual({ status: "failed", error: "timed out" });
  expect(f.seen.interrupted).toBe(true);
});

/** A fake `query` built from hooks, for stalls and throws. */
function hookQuery(h: {
  status?: () => Promise<unknown>;
  interrupt?: () => Promise<void>;
  throws?: string;
}) {
  const seen = { closed: false };
  const queryFn = ((a: { prompt: AsyncIterable<unknown> }) => {
    if (h.throws) throw new Error(h.throws);
    void (async () => {
      for await (const _ of a.prompt) {
        /* never yields */
      }
      seen.closed = true;
    })();
    return {
      mcpServerStatus: h.status ?? (async () => []),
      interrupt: h.interrupt ?? (async () => {}),
      close: () => {},
    };
  }) as never;
  return { queryFn, seen };
}

test("a mcpServerStatus that never resolves still times out and closes the input", async () => {
  const f = hookQuery({ status: () => new Promise(() => {}) });
  const probe = createMcpProbe({ env: {}, timeoutMs: 50, query: f.queryFn });
  expect(await probe("gh", http)).toEqual({ status: "failed", error: "timed out" });
  await Bun.sleep(5);
  expect(f.seen.closed).toBe(true);
});

test("an interrupt that never resolves does not hold the probe", async () => {
  const f = hookQuery({
    status: async () => [{ name: "gh", status: "needs-auth" }],
    interrupt: () => new Promise(() => {}),
  });
  const r = await createMcpProbe({ env: {}, query: f.queryFn })("gh", http);
  expect(r).toEqual({ status: "needs-auth" });
  await Bun.sleep(5);
  expect(f.seen.closed).toBe(true);
});

test("a throwing query gives failed with the message cut to 300 chars", async () => {
  const f = hookQuery({ throws: "e".repeat(400) });
  const r = await createMcpProbe({ env: {}, query: f.queryFn })("gh", http);
  expect(r).toEqual({ status: "failed", error: "e".repeat(300) });
});
