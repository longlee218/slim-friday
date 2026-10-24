import { MAX_AVATAR_BYTES } from "@friday/contracts";

/** Message of the error thrown when the encoded image is over the 2 MB limit. */
export const TOO_LARGE = "too large";
/** Longest side of the encoded avatar, in px. */
const MAX_SIDE = 512;

/** Centre square crop of a `w` x `h` image. */
export function cropSquare(w: number, h: number): { sx: number; sy: number; size: number } {
  const size = Math.min(w, h);
  return { sx: Math.round((w - size) / 2), sy: Math.round((h - size) / 2), size };
}

/** Side of the encoded square: the crop, never above 512 px. */
export const outputSize = (size: number): number => Math.min(size, MAX_SIDE);

/** `canvas.toBlob` as a promise (null becomes an error). */
const toBlob = (c: HTMLCanvasElement, type: string, q: number) =>
  new Promise<Blob>((ok, fail) =>
    c.toBlob((b) => (b ? ok(b) : fail(new Error("encode failed"))), type, q),
  );

/** A real canvas of `n` x `n` px. */
const domCanvas = (n: number): HTMLCanvasElement => {
  const c = document.createElement("canvas");
  c.width = n;
  c.height = n;
  return c;
};

/**
 * Crops the picked image to a square and encodes it: WebP, or JPEG when the browser cannot
 * encode WebP (Safari silently returns PNG, which must never be uploaded as WebP).
 * Throws `TOO_LARGE` over 2 MB.
 */
export async function encodeAvatar(
  file: File,
  makeCanvas: (n: number) => HTMLCanvasElement = domCanvas,
): Promise<{ blob: Blob; type: "image/webp" | "image/jpeg" }> {
  const bitmap = await createImageBitmap(file);
  const { sx, sy, size } = cropSquare(bitmap.width, bitmap.height);
  const out = outputSize(size);
  const canvas = makeCanvas(out);
  canvas.getContext("2d")?.drawImage(bitmap, sx, sy, size, size, 0, 0, out, out);
  let blob = await toBlob(canvas, "image/webp", 0.9);
  let type: "image/webp" | "image/jpeg" = "image/webp";
  if (blob.type !== "image/webp") {
    blob = await toBlob(canvas, "image/jpeg", 0.88);
    type = "image/jpeg";
  }
  if (blob.size > MAX_AVATAR_BYTES) throw new Error(TOO_LARGE);
  return { blob, type };
}
