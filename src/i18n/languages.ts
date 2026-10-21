/* The languages the app can speak to the owner. This list is the single place that names them: the `OwnerLanguage` type,
   the detector and the message catalogs (`locales/<code>/`) all derive from it. Adding a language = one entry here +
   one catalog folder (the compiler lists every key the new catalog still lacks). */

/** Per language: the franc (ISO 639-3) code that detects it, and optional script marks that settle it at once. */
export const LANGUAGES = {
  vi: {
    franc: "vie",
    // Vietnamese diacritics; any of them settles the language.
    marks: /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i,
  },
  en: { franc: "eng" },
} as const satisfies Record<string, { franc: string; marks?: RegExp }>;

/** A language code of the list above. */
export type OwnerLanguage = keyof typeof LANGUAGES;

/** Codes of the list, in declaration order. */
export const LANGUAGE_CODES = Object.keys(LANGUAGES) as OwnerLanguage[];

/** Used when nothing in the conversation reveals the owner's language yet. */
export const DEFAULT_LANGUAGE: OwnerLanguage = "vi";

/** The language app code words notices in first: it is the fallback of a missing key and the one `localizeUserCopy` maps from. */
export const SOURCE_LANGUAGE: OwnerLanguage = "en";
