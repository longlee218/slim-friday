import { expect, test } from "bun:test";
import { loadConfig } from "../src/config/agent-config";
import { sdkCompactLlm } from "../src/memory/memory-compaction-llm";
import { resultMsg } from "./helpers";

test("sdk call: deadline-safe options (budget, no persistence) are set", async () => {
  const config = loadConfig({ AGENT_HOME: "/tmp/x" });
  let opts: any;
  const llm = sdkCompactLlm(config, async function* (a: any) {
    opts = a.options;
    yield resultMsg({ result: "- a b c" });
  } as any);
  await llm("s", "p");
  expect(opts).toMatchObject({ maxBudgetUsd: 0.05, persistSession: false, tools: [], maxTurns: 1 });
  expect(opts.thinking).toEqual({ type: "disabled" }); // adaptive thinking cost 3-5k output tokens
});

/** Stub SDK stream that never answers and ends with an abort error when its signal fires. */
const hangingQuery = (calls: { n: number }) =>
  async function* (a: any) {
    calls.n++;
    await new Promise((_, rej) =>
      a.options.abortController.signal.addEventListener("abort", () =>
        rej(new Error("Claude Code process aborted by user")),
      ),
    );
    yield resultMsg({ result: "" });
  } as any;

test("sdk call: deadline abort reads 'timed out' and is retried once, then rejects", async () => {
  const config = loadConfig({ AGENT_HOME: "/tmp/x", TIMEOUT_MS: "20" });
  const calls = { n: 0 };
  await expect(sdkCompactLlm(config, hangingQuery(calls))("s", "p")).rejects.toThrow(
    "model call timed out after 0.02 s",
  );
  expect(calls.n).toBe(2);
});

test("sdk call: a timeout then a success is retried; a non-timeout error is not", async () => {
  const config = loadConfig({ AGENT_HOME: "/tmp/x", TIMEOUT_MS: "20" });
  let n = 0;
  const flaky = sdkCompactLlm(config, async function* (a: any) {
    if (++n === 1)
      await new Promise((_, rej) =>
        a.options.abortController.signal.addEventListener("abort", () => rej(new Error("x"))),
      );
    yield resultMsg({ result: "- ok" });
  } as any);
  expect((await flaky("s", "p")).text).toBe("- ok");
  expect(n).toBe(2);
  let m = 0;
  const failing = sdkCompactLlm(config, (() => {
    m++;
    return {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("boom")) }),
    };
  }) as any);
  await expect(failing("s", "p")).rejects.toThrow("boom");
  expect(m).toBe(1);
});
