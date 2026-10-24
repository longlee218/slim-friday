import { expect, test } from "bun:test";
import type { QueryFn } from "../src/session/build-options";
import { consolidateNotes } from "../src/session/consolidate-notes";

/** A fake `query` that answers with one success result and remembers the prompt it got. */
function fake(answer: string | Error) {
  const seen: { options?: Record<string, unknown>; prompt?: unknown } = {};
  const queryFn = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    seen.options = args.options;
    seen.prompt = args.prompt;
    return (async function* () {
      if (answer instanceof Error) throw answer;
      yield { type: "result", subtype: "success", result: answer };
    })();
  }) as unknown as QueryFn;
  return { queryFn, seen };
}

test("parses a JSON array of {kind, note}; drops bad kinds and empty notes; caps 5", async () => {
  const items = [
    { kind: "fact", note: "deploy uses docker" },
    { kind: "secret", note: "bad kind" },
    { kind: "lesson", note: "  " },
    ...Array.from({ length: 12 }, (_, i) => ({ kind: "decision", note: `d${i}` })),
  ];
  const { queryFn, seen } = fake(`\`\`\`json\n${JSON.stringify(items)}\n\`\`\``);
  const out = await consolidateNotes(
    { memory: "## Facts\n- x", notes: ["a", "b"] },
    { model: "m", queryFn },
  );
  expect(out?.[0]).toEqual({ kind: "fact", note: "deploy uses docker" });
  expect(out).toHaveLength(5);
  expect(seen.options).toMatchObject({ tools: [], maxTurns: 1, settingSources: [], model: "m" });
  expect(String(seen.prompt)).toContain("1. a");
  expect(String(seen.prompt)).toContain("- x");
});

test("a failed or non-JSON answer is undefined; an empty array is []", async () => {
  const input = { memory: "", notes: ["a"] };
  expect(
    await consolidateNotes(input, { model: "m", queryFn: fake(new Error("down")).queryFn }),
  ).toBeUndefined();
  expect(
    await consolidateNotes(input, { model: "m", queryFn: fake("no idea").queryFn }),
  ).toBeUndefined();
  expect(await consolidateNotes(input, { model: "m", queryFn: fake("[]").queryFn })).toEqual([]);
});

test("a large memory is cut so every note and the closing tag reach the model", async () => {
  const { queryFn, seen } = fake("[]");
  const notes = Array.from({ length: 100 }, (_, i) => `note ${i} ${"n".repeat(180)}`);
  await consolidateNotes({ memory: "m".repeat(100_000), notes }, { model: "m", queryFn });
  const prompt = String(seen.prompt);
  expect(prompt).toContain(`100. ${notes[99]}`);
  expect(prompt.endsWith("</notes>")).toBe(true);
  expect(prompt.length).toBeLessThanOrEqual(80_000);
});

test("the prompt tells the model what is not worth keeping and to prefer nothing when unsure", async () => {
  const { queryFn, seen } = fake("[]");
  await consolidateNotes({ memory: "", notes: ["a"] }, { model: "m", queryFn });
  const prompt = String(seen.options?.systemPrompt);
  expect(prompt).toContain("default answer is []");
  expect(prompt).toContain("task progress");
  expect(prompt).toContain("readable from the code");
});

test("a positive integer replaces is kept; any other replaces is dropped and the note stays", async () => {
  const items = [
    { kind: "preference", note: "answer in English", replaces: 2 },
    { kind: "fact", note: "uses bun", replaces: 1.5 },
    { kind: "fact", note: "uses node", replaces: "3" },
    { kind: "fact", note: "uses deno", replaces: 0 },
  ];
  const { queryFn } = fake(JSON.stringify(items));
  const out = await consolidateNotes({ memory: "[1] x", notes: ["a"] }, { model: "m", queryFn });
  expect(out).toEqual([
    { kind: "preference", note: "answer in English", replaces: 2 },
    { kind: "fact", note: "uses bun" },
    { kind: "fact", note: "uses node" },
    { kind: "fact", note: "uses deno" },
  ]);
});
