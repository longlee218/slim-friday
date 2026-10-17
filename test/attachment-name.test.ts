import { expect, test } from "bun:test";
import { attachmentName, headingTitle } from "../src/ingress/attachment-name";
import { INLINE_MAX, TABLE_WRAP_WIDTH, wrapTables } from "../src/ingress/inline-report";

test("headingTitle: first `# ` line only, else undefined", () => {
  expect(headingTitle("intro\n# Kế hoạch  \n## Sub\n# Second")).toBe("Kế hoạch");
  expect(headingTitle("## Sub only\ntext")).toBeUndefined();
  expect(headingTitle("#nospace")).toBeUndefined();
});

test("attachmentName: accents folded (incl. đ), unsafe chars to a single `-`", () => {
  expect(attachmentName("Giáo án 8 tuần Kiều Seal", "md")).toBe("giao-an-8-tuan-kieu-seal.md");
  expect(attachmentName("Đường dẫn: ../etc/passwd?*", "md")).toBe("duong-dan-etc-passwd.md");
  expect(attachmentName("a/b\\c\0d", "md")).toBe("a-b-c-d.md");
});

test("attachmentName: no title, empty slug or a name over 255 bytes falls back, never cut", () => {
  expect(attachmentName(undefined, "md")).toBe("reply.md");
  expect(attachmentName("???", "md")).toBe("reply.md");
  expect(attachmentName("x".repeat(300), "md")).toBe("reply.md");
  expect(attachmentName("x".repeat(251), "md")).toBe(`${"x".repeat(251)}.md`); // exactly 254 bytes
  expect(attachmentName("ế".repeat(100), "md")).toBe(`${"e".repeat(100)}.md`); // folded to ASCII first
  expect(attachmentName("日本語".repeat(30), "md")).toBe("reply.md"); // 90 chars, 270 bytes
  expect(attachmentName(undefined, "diff", { fallback: "changes" })).toBe("changes.diff");
  expect(attachmentName("Fix", "diff", { prefix: "2026-10-18-" })).toBe("2026-10-18-fix.diff");
});

test("wrapTables: a small table is fenced, a wide one and one inside a fence are left alone", () => {
  expect(wrapTables("a\n| x | y |\n|---|---|\n| 1 | 2 |\nb")).toBe(
    "a\n```\n| x | y |\n|---|---|\n| 1 | 2 |\n```\nb",
  );
  const wide = `| ${"w".repeat(TABLE_WRAP_WIDTH)} |\n|---|\n| 1 |`;
  expect(wrapTables(wide)).toBe(wide);
  const fenced = "```\n| x |\n|---|\n| 1 |\n```";
  expect(wrapTables(fenced)).toBe(fenced);
  expect(INLINE_MAX).toBe(3900);
});

test("headingTitle skips lines inside a code fence", () => {
  expect(headingTitle("```sh\n# install deps\n```\n\n# Real title\nbody")).toBe("Real title");
  expect(headingTitle("```sh\n# only a comment\n```")).toBeUndefined();
});

test("attachmentName is ASCII only: a title with no Latin letter falls back", () => {
  expect(attachmentName("Giáo án 8 tuần", "md")).toBe("giao-an-8-tuan.md");
  expect(attachmentName("计划 план", "md")).toBe("reply.md");
});
