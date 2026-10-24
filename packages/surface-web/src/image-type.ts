/** Image types the web app shows inline. */
export type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** True when `head` starts with `bytes` at `offset`. */
function at(head: Uint8Array, offset: number, bytes: number[]): boolean {
  return bytes.every((b, i) => head[offset + i] === b);
}

/** The image type named by the magic bytes (never by the file name), or `undefined`. */
export function imageType(head: Uint8Array): ImageType | undefined {
  if (at(head, 0, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (at(head, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // RIFF....WEBP
  if (at(head, 0, [0x52, 0x49, 0x46, 0x46]) && at(head, 8, [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  // GIF87a / GIF89a
  if (at(head, 0, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39)) {
    if (head[5] === 0x61) return "image/gif";
  }
  return undefined;
}
