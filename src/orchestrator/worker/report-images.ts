import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { REPORT_IMAGE_MAX_BYTES } from "../../artifacts/artifact-limits";
import { isInside } from "../../policy/paths";

/** One screenshot a report sends to the owner: its file name and real path (inside the run's scratch dir). */
export interface ReportImage {
  name: string;
  path: string;
}

/** Extensions a report may send, with the magic bytes that must start (or, for webp, frame) the file. */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/** True when the first bytes are a PNG, JPEG or WEBP header (the extension alone proves nothing). */
function hasImageMagic(head: Buffer): boolean {
  const png = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpeg = head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const webp =
    head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP";
  return png || jpeg || webp;
}

/** First 12 bytes of a file. */
function readHead(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(12);
    readSync(fd, head, 0, 12, 0);
    return head;
  } finally {
    closeSync(fd);
  }
}

/**
 * Check the screenshots a report names: each path must be a file inside the run's scratch dir (real path: a symlink out
 * of it is refused), an allowed image extension, with image magic bytes and at most `REPORT_IMAGE_MAX_BYTES`.
 * Returns the images, or one error per refused entry (the report is then NOT stored: the worker fixes it).
 */
export function checkReportImages(
  paths: string[],
  scratchDir: string | undefined,
): { images: ReportImage[] } | { errors: string[] } {
  if (!scratchDir) return { errors: ["images: this run has no scratch dir"] };
  const errors: string[] = [];
  const images: ReportImage[] = [];
  let root: string;
  try {
    root = realpathSync(scratchDir);
  } catch {
    return { errors: ["images: the scratch dir does not exist"] };
  }
  paths.forEach((p, i) => {
    try {
      const real = realpathSync(p);
      if (!isInside(root, real)) throw new Error("not inside the scratch dir");
      if (!IMAGE_EXTS.has(extname(real).toLowerCase())) throw new Error("not png, jpeg or webp");
      const st = statSync(real);
      if (!st.isFile()) throw new Error("not a file");
      if (st.size > REPORT_IMAGE_MAX_BYTES)
        throw new Error(`over ${REPORT_IMAGE_MAX_BYTES} bytes: retake it smaller`);
      if (!hasImageMagic(readHead(real))) throw new Error("not an image file");
      images.push({ name: basename(real), path: real });
    } catch (err) {
      errors.push(`images[${i}]: ${err instanceof Error ? err.message : "unreadable"}`);
    }
  });
  return errors.length ? { errors } : { images };
}
