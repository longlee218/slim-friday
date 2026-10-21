import type { OwnerLanguage } from "./languages";
import { SOURCE_LANGUAGE } from "./languages";
import { en } from "./locales/en";
import { vi } from "./locales/vi";

/** Every message key of the catalogs; `en` is the source, so a key exists when `en` has it. */
export type MessageKey = keyof typeof en;

/** One catalog per language of `LANGUAGES`: a language missing here fails to compile. */
const CATALOGS: Record<OwnerLanguage, Partial<Record<MessageKey, string>>> = { en, vi };

/** Values a message may carry in its `{name}` placeholders. */
export type MessageParams = Record<string, string | number>;

/**
 * The text of `key` in `language`, with `{name}` placeholders filled from `params`.
 * A key the language lacks falls back to the source language, so a half-finished catalog never shows a key.
 */
export function t(language: OwnerLanguage, key: MessageKey, params: MessageParams = {}): string {
  const template = CATALOGS[language][key] ?? CATALOGS[SOURCE_LANGUAGE][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (hole, name: string) =>
    name in params ? String(params[name]) : hole,
  );
}
