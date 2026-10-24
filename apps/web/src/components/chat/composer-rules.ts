/** Files per message (same cap as the server). */
export const MAX_FILES = 5;
/** Bytes per file (20 MB, same cap as the server). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Checks files before any network call. `current` is how many chips already sit in the
 * composer. The empty-file refusal mirrors the server (`createUpload` rejects size 0).
 */
export function checkFiles(
  current: number,
  files: { name: string; size: number }[],
): { ok: true } | { ok: false; error: string } {
  if (current + files.length > MAX_FILES) return { ok: false, error: "Up to 5 files per message." };
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) return { ok: false, error: `${f.name} is over 20 MB.` };
    if (f.size === 0) return { ok: false, error: `${f.name} is empty.` };
  }
  return { ok: true };
}

/** Send is allowed with text or a file, and only once every upload finished. */
export function canSend(s: {
  text: string;
  uploads: { state: "uploading" | "done" | "failed" }[];
}): boolean {
  const hasContent = s.text.trim().length > 0 || s.uploads.length > 0;
  return hasContent && s.uploads.every((u) => u.state === "done");
}

/** Tallest the textarea grows before it scrolls, in px. */
export function composerMaxHeight(phone: boolean): number {
  return phone ? 120 : 200;
}

/** Enter sends on desktop only; Shift+Enter is a new line and IME composition is never cut. */
export function sendOnEnter(
  e: { key: string; shiftKey: boolean; isComposing: boolean },
  phone: boolean,
): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && !phone;
}

/** Placeholder: the bot's name or the group's name, shorter on a phone. */
export function placeholderFor(
  title: string,
  groupName: string | undefined,
  phone: boolean,
): string {
  if (phone) return groupName ? "Message · @ a member" : "Message";
  return groupName ? `Message ${groupName} · @ to address a member` : `Message ${title}`;
}
