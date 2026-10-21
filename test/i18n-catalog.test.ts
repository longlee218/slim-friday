import { expect, test } from "bun:test";
import { LANGUAGE_CODES, SOURCE_LANGUAGE } from "../src/i18n/languages";
import { en } from "../src/i18n/locales/en";
import { vi } from "../src/i18n/locales/vi";
import { t } from "../src/i18n/translate";
import { detectLanguage } from "../src/ingress/user-copy";

const CATALOGS: Record<string, Record<string, string>> = { en, vi };
const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("every listed language has a catalog with the source language's keys", () => {
  for (const code of LANGUAGE_CODES) {
    expect(CATALOGS[code]).toBeDefined();
    expect(Object.keys(CATALOGS[code] ?? {}).sort()).toEqual(
      Object.keys(CATALOGS[SOURCE_LANGUAGE] ?? {}).sort(),
    );
  }
});

test("every language fills the same placeholders as the source text", () => {
  for (const code of LANGUAGE_CODES)
    for (const [key, text] of Object.entries(CATALOGS[code] ?? {}))
      expect({ code, key, holes: holes(text) }).toEqual({
        code,
        key,
        holes: holes(CATALOGS[SOURCE_LANGUAGE]?.[key] ?? ""),
      });
});

test("t fills placeholders and keeps an unknown one visible", () => {
  expect(t("en", "digest.done", { done: 1, total: 3 })).toBe("1 of 3 items done.");
  expect(t("vi", "digest.done", { done: 1, total: 3 })).toBe("Xong 1/3 việc.");
  expect(t("en", "digest.done", { done: 1 })).toBe("1 of {total} items done.");
});

test("the detector only answers with a listed language", () => {
  expect(detectLanguage("Chào bạn, giúp mình với")).toBe("vi");
  expect(detectLanguage("Please help me fix the failing build today")).toBe("en");
});
