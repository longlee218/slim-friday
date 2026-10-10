import { describe, expect, test } from "bun:test";
import { computeEffortSignals } from "../src/intent/effort-signals";
import { loadLexicon } from "../src/intent/load-lexicon";
import { stripIgnored, tokenizeMessage, tokenizePhrase } from "../src/intent/normalize-text";
import { groupFires, matchesPhrase } from "../src/intent/phrase-matcher";

const lexicon = loadLexicon();
const ids = (text: string): string[] => computeEffortSignals(text, lexicon).ruleIds;

describe("normalize-text", () => {
  test("NFC, lowercase, accents and đ stripped; punctuation becomes a boundary", () => {
    expect(tokenizePhrase("Đừng LÀM lại, nhé!")).toEqual(["dung", "lam", "lai", "|", "nhe", "|"]);
    // decomposed (NFD) input equals composed input
    expect(tokenizePhrase("lạc đề".normalize("NFD"))).toEqual(tokenizePhrase("lạc đề"));
    expect(tokenizePhrase("trade-off")).toEqual(["trade", "off"]);
  });
  test("backticks, fenced code, pasted logs and quotes are ignored", () => {
    expect(tokenizeMessage("xem `sai roi` nhe")).toEqual(["xem", "nhe"]);
    expect(tokenizeMessage("a\n```\nsai roi\nlam lai\n```\nb")).not.toContain("sai");
    const logs = "2026-10-10 12:00:01 ERROR sai roi\n  at fn (a.ts:1:2)\n$ npm run làm lại\nok";
    expect(tokenizeMessage(logs).filter((x) => x !== "|")).toEqual(["ok"]);
    expect(stripIgnored("> sai roi\nhi")).not.toContain("sai");
    // an unterminated fence swallows the rest
    expect(tokenizeMessage("hi ```sai roi").filter((x) => x !== "|")).toEqual(["hi"]);
  });
});

describe("phrase-matcher", () => {
  const t = tokenizeMessage;
  test("word boundaries: phrase never matches inside a longer word", () => {
    expect(matchesPhrase(t("làm lại đi"), ["lam", "lai"])).toBe(true);
    expect(matchesPhrase(t("bia"), ["bi"])).toBe(false);
    expect(matchesPhrase(t("tai lam laixe"), ["lam", "lai"])).toBe(false);
  });
  test("negation window of 3 words, stops at a clause boundary", () => {
    expect(matchesPhrase(t("không sai rồi"), ["sai", "roi"])).toBe(false);
    expect(matchesPhrase(t("đừng làm lại"), ["lam", "lai"])).toBe(false);
    expect(matchesPhrase(t("đừng có vội làm lại"), ["lam", "lai"])).toBe(false); // 3 words before
    expect(matchesPhrase(t("đừng có vội mà làm lại"), ["lam", "lai"])).toBe(true); // 4 words: out of window
    expect(matchesPhrase(t("không sao, sai rồi"), ["sai", "roi"])).toBe(true); // comma = boundary
  });
  test("weak words never fire alone, pairs do", () => {
    expect(groupFires(t("sai"), [], [["sai"], ["nham"]])).toBe(false);
    expect(groupFires(t("sai và nhầm"), [], [["sai"], ["nham"]])).toBe(true);
  });
});

/** [text, group ids expected]. Covers accented and plain forms, one case at least per group and phrase family. */
const POSITIVES: [string, string[]][] = [
  ["Sai rồi, làm lại đi", ["reject_previous"]],
  ["sai roi", ["reject_previous"]],
  ["sai hoàn toàn", ["reject_previous"]],
  ["câu trả lời này không đúng", ["reject_previous"]],
  ["cau tra loi nay chua dung", ["reject_previous"]],
  ["bạn lạc đề rồi", ["reject_previous"]],
  ["không liên quan gì cả", ["reject_previous"]],
  ["hiểu sai ý tôi", ["reject_previous"]],
  ["hieu nham y toi", ["reject_previous"]],
  ["trả lời lại giúp", ["reject_previous"]],
  ["viết lại phần này", ["reject_previous"]],
  ["đây không phải cái tôi cần", ["reject_previous"]],
  ["that is wrong, redo it", ["reject_previous"]],
  ["Trả lời sơ sài quá", ["quality_complaint"]],
  ["so sai qua", ["quality_complaint"]],
  ["trả lời hời hợt", ["quality_complaint"]],
  ["viết cẩu thả", ["quality_complaint"]],
  ["trả lời qua loa", ["quality_complaint"]],
  ["câu trả lời chung chung", ["quality_complaint"]],
  ["thiếu căn cứ", ["quality_complaint"]],
  ["chưa ổn", ["quality_complaint"]],
  ["tôi thất vọng", ["quality_complaint"]],
  ["kết quả không dùng được", ["quality_complaint", "reject_previous"]],
  ["too vague", ["quality_complaint"]],
  ["bịa và ẩu", ["quality_complaint"]],
  ["Hãy suy nghĩ kỹ rồi trả lời", ["think_carefully"]],
  ["nghi ky nhe", ["think_carefully"]],
  ["xem xét kỹ", ["think_carefully"]],
  ["tìm hiểu kỹ", ["think_carefully"]],
  ["cân nhắc giúp", ["think_carefully"]],
  ["hãy cẩn thận", ["think_carefully"]],
  ["đừng vội", ["think_carefully"]],
  ["think carefully please", ["think_carefully"]],
  ["Phân tích lỗi này", ["analyze_judge"]],
  ["danh gia giai phap", ["analyze_judge"]],
  ["phản biện kế hoạch", ["analyze_judge"]],
  ["thẩm định", ["analyze_judge"]],
  ["so sánh hai cách", ["analyze_judge"]],
  ["tìm root cause", ["analyze_judge"]],
  ["đánh đổi giữa hai bên", ["analyze_judge"]],
  ["what is the trade-off", ["analyze_judge"]],
  ["Thiết kế lại module này", ["design_synthesize"]],
  ["kiến trúc hệ thống", ["design_synthesize"]],
  ["lập kế hoạch migration", ["design_synthesize"]],
  ["chiến lược cache", ["design_synthesize"]],
  ["đề xuất giải pháp", ["design_synthesize"]],
  ["tái cấu trúc code", ["design_synthesize"]],
  ["mô hình hóa dữ liệu", ["design_synthesize"]],
  ["thiết kế và giải pháp", ["design_synthesize"]], // two weak words together
  ["Xác minh lại giúp", ["verify"]],
  ["đối chiếu nguồn", ["verify"]],
  ["dẫn nguồn đầy đủ", ["verify"]],
  ["cần nguồn chính thức", ["verify"]],
  ["xem tài liệu chính thức", ["verify"]],
  ["phiên bản mới nhất", ["verify"]],
  ["Đồng thời hỗ trợ cả hai", ["many_constraints"]],
  ["với điều kiện không đổi API", ["many_constraints"]],
  ["xét các trường hợp biên", ["many_constraints"]],
  ["có ngoại lệ nào", ["many_constraints"]],
  ["rủi ro là gì", ["many_constraints"]],
  ["cover edge cases", ["many_constraints"]],
  ["Nhanh thôi nhé", ["want_fast"]],
  ["ngắn gọn", ["want_fast"]],
  ["tóm tắt file này", ["want_fast"]],
  ["xem sơ qua", ["want_fast"]],
  ["không cần chi tiết", ["want_fast"]],
  ["briefly", ["want_fast"]],
];

/** Texts that must fire NOTHING: negations, ambiguous single words, code / log / quoted text. */
const NEGATIVES: string[] = [
  "không sai",
  "khong sai",
  "đừng làm lại",
  "dung lam lai",
  "chưa cần làm lại",
  "không cần suy nghĩ kỹ", // negated think_carefully
  "đừng phân tích",
  "không có rủi ro",
  "sai số 5%", // "sai so": ambiguous single word
  "sai so cho phep",
  "mở file thiết kế",
  "file thiet ke cua module A",
  "sai", // weak word alone
  "thiết kế", // weak word alone
  "xem `sai roi` nhé", // inline code
  "```\nsai roi\nlam lai\n```",
  "2026-10-10 12:00:00 ERROR không đúng làm lại",
  "> sai roi, lam lai",
  "$ echo phân tích",
  "hello, how are you",
  "",
];

describe("effort signals corpus", () => {
  test.each(POSITIVES)("fires: %s", (text, expected) => {
    const got = ids(text);
    for (const id of expected) expect(got).toContain(id);
  });
  test.each(NEGATIVES)("silent: %j", (text) => {
    expect(ids(text)).toEqual([]);
  });
  test("accented and plain forms give the same ids (all positives)", () => {
    for (const [text] of POSITIVES) {
      const plain = text
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D");
      expect(ids(plain)).toEqual(ids(text));
    }
  });
  test("corpus size", () => {
    expect(POSITIVES.length + NEGATIVES.length).toBeGreaterThanOrEqual(80);
  });
});

describe("effort signals values", () => {
  const sig = (s: string) => computeEffortSignals(s, lexicon);
  test("rejection and complaint: floor +1 once, not +2", () => {
    expect(sig("sai rồi, trả lời sơ sài").floorDelta).toBe(1);
  });
  test("think carefully +1, want fast -1, both cancel", () => {
    expect(sig("nghĩ kỹ").turnDelta).toBe(1);
    expect(sig("nhanh thôi").turnDelta).toBe(-1);
    expect(sig("nghĩ kỹ nhưng ngắn gọn").turnDelta).toBe(0);
  });
  test("analyze -> min high; design -> min high + class design; verify -> lookup", () => {
    expect(sig("phân tích").minEffort).toBe("high");
    expect(sig("kiến trúc").classHint).toBe("design");
    expect(sig("xác minh").lookup).toBe(true);
    expect(sig("hello")).toEqual({ floorDelta: 0, turnDelta: 0, lookup: false, ruleIds: [] });
  });
  test("turn delta is clamped", () => {
    expect(
      Math.abs(sig("nghĩ kỹ, đồng thời, ngoại lệ, rủi ro, cẩn thận").turnDelta),
    ).toBeLessThanOrEqual(2);
  });
});
