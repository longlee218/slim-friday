import { describe, expect, test } from "bun:test";
import {
  buildAnswerModal,
  buildChoiceRows,
  choiceLayout,
  threadLanguage,
} from "../src/ingress/discord-components";
import { openDb } from "../src/storage/db";
import { insertTurn } from "../src/storage/run-store";

const opts = (n: number, len = 5) => Array.from({ length: n }, (_, i) => `${i}`.padEnd(len, "x"));
const json = (rows: any[]) => rows.map((r) => r.toJSON());

describe("choiceLayout", () => {
  test("1-5 short options are buttons", () => {
    expect(choiceLayout(opts(1))).toBe("buttons");
    expect(choiceLayout(opts(2))).toBe("buttons");
    expect(choiceLayout(opts(5, 80))).toBe("buttons");
  });
  test("6-25 options are a select menu", () => {
    expect(choiceLayout(opts(6))).toBe("select");
    expect(choiceLayout(opts(25, 100))).toBe("select");
  });
  test("no options, too many, or labels too long are typed answers", () => {
    expect(choiceLayout([])).toBe("modal");
    expect(choiceLayout(opts(26))).toBe("modal");
    expect(choiceLayout(opts(3, 101))).toBe("modal");
    expect(choiceLayout(opts(7, 101))).toBe("modal");
  });
  test("a few options with a label over 80 chars are listed in the attachment and typed", () => {
    expect(choiceLayout(opts(3, 90))).toBe("modal");
  });
});

describe("builders", () => {
  test("button ids encode request id and index only", () => {
    const [row] = json(buildChoiceRows("abcd1234", ["secret one", "secret two"], "buttons", "en"));
    expect(row.components.map((c: any) => c.custom_id)).toEqual([
      "choice:abcd1234:0",
      "choice:abcd1234:1",
    ]);
  });
  test("select carries up to 25 options as indices and a localized placeholder", () => {
    const rows = json(buildChoiceRows("abcd1234", opts(25), "select", "vi"));
    expect(rows[0].components[0].options).toHaveLength(25);
    expect(rows[0].components[0].options[3].value).toBe("3");
    expect(rows[0].components[0].placeholder).toBe("Chọn một đáp án");
    expect(rows[1].components[0].label).toBe("Nhập câu trả lời");
  });
  test("modal id holds only the request id", () => {
    const m = buildAnswerModal("abcd1234", "en").toJSON();
    expect(m.custom_id).toBe("choice:abcd1234:m");
    expect(m.title).toBe("Your answer");
  });
});

describe("threadLanguage", () => {
  test("follows the latest brief, Vietnamese when unknown", () => {
    const db = openDb(":memory:");
    expect(threadLanguage(db, "none")).toBe("vi");
    insertTurn(db, {
      id: "t",
      threadId: "th",
      source: "discord",
      location: "r",
      role: "assistant",
      brief: "Please run the tests in this repository and tell me what failed",
    });
    expect(threadLanguage(db, "th")).toBe("en");
  });
});
