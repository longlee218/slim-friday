import { expect, test } from "bun:test";
import { EPISODE_ABSTRACT_CHARS, EPISODE_TOPICS_MAX } from "../src/config/memory-caps";
import { abstractOf, keyTopics } from "../src/memory/episode-abstract";

test("abstract: short text kept whole, whitespace collapsed", () => {
  expect(abstractOf("One.\n\nTwo   words.")).toBe("One. Two words.");
});

test("abstract: whole sentences while they fit, never past the limit", () => {
  const s = `${"a".repeat(300)}. ${"b".repeat(150)}. ${"c".repeat(100)}.`;
  const out = abstractOf(s);
  expect(out).toBe(`${"a".repeat(300)}. ${"b".repeat(150)}.`);
  expect(out.length).toBeLessThanOrEqual(EPISODE_ABSTRACT_CHARS);
});

test("abstract: a first sentence longer than the limit is cut", () => {
  expect(abstractOf("x".repeat(900))).toHaveLength(EPISODE_ABSTRACT_CHARS);
  expect(abstractOf("abcdef ghijkl", 8)).toBe("abcdef g");
});

test("topics: by frequency, ties by first seen, stopwords/short/numbers out, case folded", () => {
  const t = "Deploy the deploy pipeline pipeline Quyet quyet cache 2024 and for cache cache";
  expect(keyTopics(t)).toBe("cache deploy pipeline quyet");
});

test("topics: at most EPISODE_TOPICS_MAX", () => {
  const words = Array.from(
    { length: 30 },
    (_, i) => `word${String.fromCharCode(97 + (i % 26))}x${i}`,
  );
  expect(keyTopics(words.join(" ")).split(" ")).toHaveLength(EPISODE_TOPICS_MAX);
});

test("topics: empty text gives an empty string", () => {
  expect(keyTopics("")).toBe("");
});
