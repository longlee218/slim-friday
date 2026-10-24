import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "@friday/core";

/** The part of `fetch` the download uses (a test passes its own). */
export type FetchFn = (url: string) => Promise<Response>;

/** A file as Discord lists it on a message. */
export interface IncomingAttachment {
  url: string;
  name: string;
  contentType?: string;
  size: number;
}

/** At most this many files of one message are taken; the rest are refused. */
export const MAX_FILES = 5;
/** Largest file taken, in bytes. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Longest saved name after sanitising. */
const MAX_NAME = 100;

/** Last path part with every character outside `[A-Za-z0-9._-]` replaced by `_`, cut to `MAX_NAME`. */
function safeName(raw: string): string {
  const base = raw.split("/").pop() ?? "";
  return (base.replace(/[^A-Za-z0-9._-]/g, "_") || "file").slice(0, MAX_NAME);
}

/** Read a response body, stopping (and returning undefined) as soon as it passes `MAX_FILE_BYTES`. */
async function readCapped(res: Response): Promise<Uint8Array | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_FILE_BYTES) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Save the files of one message under `dir` as `<n>-<safe name>` (written with `wx`, so nothing is overwritten).
 * A file past the count or size cap, or one that fails to download, is named in `refused`; the others are saved.
 */
export async function downloadAttachments(
  list: IncomingAttachment[],
  dir: string,
  fetchFn: FetchFn = (url) => fetch(url),
): Promise<{ saved: Attachment[]; refused: string[] }> {
  const saved: Attachment[] = [];
  const refused: string[] = [];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [i, a] of list.entries()) {
    if (i >= MAX_FILES) {
      refused.push(`${a.name} (more than ${MAX_FILES} files)`);
      continue;
    }
    if (a.size > MAX_FILE_BYTES) {
      refused.push(`${a.name} (over ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
      continue;
    }
    try {
      const res = await fetchFn(a.url);
      const body = res.ok ? await readCapped(res) : undefined;
      if (!body) {
        refused.push(`${a.name} (download failed or too large)`);
        continue;
      }
      const name = `${i + 1}-${safeName(a.name)}`;
      const path = join(dir, name);
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      saved.push({
        name,
        mimeType: a.contentType ?? "application/octet-stream",
        path,
        size: body.length,
      });
    } catch {
      refused.push(`${a.name} (download failed)`);
    }
  }
  return { saved, refused };
}
