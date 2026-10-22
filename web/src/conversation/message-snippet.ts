import type { Message } from "../chat/chat-types";

/** Human file size: 980 B, 4 KB, 2.4 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${+(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Upper-case extension shown on a file tile ("PDF", "MD"); "FILE" when there is none. */
export function fileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
}

/** One-line summary of a message, used by reply quotes and the reply bar. */
export function snippet(m: Message): string {
  switch (m.kind) {
    case "text": {
      if (m.text) return m.text;
      const files = m.attachments ?? [];
      const photos = files.filter((a) => a.type === "image").length;
      if (photos === files.length) return photos === 1 ? "Photo" : `${photos} photos`;
      return files.length === 1 ? files[0].name : `${files.length} files`;
    }
    case "file":
      return m.name;
    case "task":
    case "approval":
      return m.title;
    case "question":
      return m.text;
    default:
      return "";
  }
}

/** First image of a message, for the thumbnail in a reply quote. */
export function firstImage(m: Message): string | undefined {
  return m.kind === "text" ? m.attachments?.find((a) => a.type === "image")?.url : undefined;
}
