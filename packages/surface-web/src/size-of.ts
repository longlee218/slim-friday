import { imageSize } from "image-size";

/** Pixel size of an image, or `undefined` when the bytes cannot be read as one. */
export function sizeOf(bytes: Uint8Array): { width: number; height: number } | undefined {
  try {
    const { width, height } = imageSize(bytes);
    return width && height ? { width, height } : undefined;
  } catch {
    return undefined;
  }
}
