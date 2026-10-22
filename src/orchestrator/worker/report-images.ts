import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { REPORT_IMAGE_MAX_BYTES } from "../../artifacts/artifact-limits";
import { isInside } from "../../policy/paths";

/** Longest image URL a report may carry. */
const IMAGE_URL_MAX_CHARS = 2000;

/**
 * One image a report sends to the owner: a file (its name and real path inside the run's scratch dir, sent as an upload)
 * or an https URL (posted as a link, Discord shows it inline; the app never fetches it).
 */
export type ReportImage = { name: string; path: string } | { name: string; url: string };

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
 * Check the images a report names. An https URL is accepted as it is (nothing is fetched). Any other entry is a file
 * path and must be a file inside the run's scratch dir (a relative path, like the Playwright server's
 * `./page-<ts>.png`, is read from it; real path: a symlink out of it is refused), an allowed image extension, with
 * image magic bytes and at most `REPORT_IMAGE_MAX_BYTES`.
 * Returns the images, or one error per refused entry (the report is then NOT stored: the worker fixes it).
 */
export function checkReportImages(
  paths: string[],
  scratchDir: string | undefined,
): { images: ReportImage[] } | { errors: string[] } {
  const errors: string[] = [];
  const images: ReportImage[] = [];
  // The scratch dir is needed only by file paths: an https URL is sent as it is.
  let root: string | undefined;
  if (scratchDir) {
    try {
      root = realpathSync(scratchDir);
    } catch {
      root = undefined;
    }
  }
  paths.forEach((p, i) => {
    try {
      if (/^https?:\/\//i.test(p)) {
        const url = new URL(p);
        if (url.protocol !== "https:") throw new Error("a URL must be https");
        if (p.length > IMAGE_URL_MAX_CHARS)
          throw new Error(`URL over ${IMAGE_URL_MAX_CHARS} chars`);
        images.push({ name: basename(url.pathname) || url.hostname, url: url.href });
        return;
      }
      if (!root) throw new Error("this run has no scratch dir for a file");
      const real = realpathSync(resolve(root, p));
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
