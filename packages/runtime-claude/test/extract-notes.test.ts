import { expect, test } from "bun:test";
import type { QueryFn } from "../src/session/build-options";
import { extractNotes } from "../src/session/extract-notes";

/** A fake `query` that answers with one success result and remembers the options it got. */
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

test("extractNotes returns the parsed notes, at most 5, from a tool-less one-turn query", async () => {
  const { queryFn, seen } = fake(JSON.stringify(["a", "b", "c", "d", "e", "f"]));
  expect(await extractNotes("summary", { model: "m", queryFn })).toEqual(["a", "b", "c", "d", "e"]);
  expect(seen.options).toMatchObject({ tools: [], maxTurns: 1, settingSources: [], model: "m" });
});

test("extractNotes finds the array inside a fenced answer and caps the input", async () => {
  const { queryFn, seen } = fake('```json\n["likes tea"]\n```');
  expect(await extractNotes("x".repeat(30000), { model: "m", queryFn })).toEqual(["likes tea"]);
  expect(String(seen.prompt).length).toBeLessThanOrEqual(20000);
});

test("extractNotes returns [] on prose or an error", async () => {
  expect(await extractNotes("s", { model: "m", queryFn: fake("nothing here").queryFn })).toEqual(
    [],
  );
  expect(await extractNotes("s", { model: "m", queryFn: fake(new Error("down")).queryFn })).toEqual(
    [],
  );
});

test("extractNotes scrubs the env like a bot's: no API key or base URL, the OAuth token on top", async () => {
  const { queryFn, seen } = fake("[]");
  await extractNotes("s", {
    model: "m",
    queryFn,
    oauthToken: "tok",
    env: { PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "http://x" },
  });
  const env = seen.options?.env as Record<string, string | undefined>;
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  expect(env.PATH).toBe("/bin");
});
