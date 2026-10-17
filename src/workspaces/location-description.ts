import { closeSync, constants, lstatSync, openSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { redactText } from "../observability/redact";

/** Longest description kept (chars). */
const MAX_DESCRIPTION = 80;
/** Bytes of the README read to find the H1. */
const README_BYTES = 8192;

/**
 * Control chars (C0, DEL, C1), zero-width and direction marks (U+200B-200F), line/paragraph separators (U+2028/2029), bidi
 * overrides and isolates (U+202A-202E, U+2066-2069), BOM and backticks: replaced by a space. Built from a string so the
 * source file holds only escapes (a literal U+2028 inside a regex literal is a syntax error).
 */
// biome-ignore lint/complexity/useRegexLiterals: a regex literal would need a raw U+2028, a syntax error
const INVISIBLE = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff`]",
  "g",
);

/**
 * First 8 KB of `dir/file` as text, or undefined. Only a regular file counts: `lstat` refuses a symlink (it could point
 * outside the dir), a FIFO or a device; the open uses O_NOFOLLOW + O_NONBLOCK so a swap after the check cannot hang or escape.
 */
function readHead(dir: string, file: string): string | undefined {
  const path = join(dir, file);
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const buf = Buffer.alloc(README_BYTES);
      return buf.subarray(0, readSync(fd, buf, 0, README_BYTES, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** First `# ` heading outside a code fence (a BOM is ignored), or undefined. */
function firstH1(text: string): string | undefined {
  let fence = false;
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && line.startsWith("# ")) return line.slice(2);
  }
  return undefined;
}

/** Heading text -> plain text: markdown images/links keep their label, HTML tags, emphasis marks and a closing `#` run go. */
function plain(h1: string): string {
  return h1
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[*~]/g, "")
    .replace(INVISIBLE, " ")
    .replace(/\s+#+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One-line description: the first `# ` heading of README.md / README (regular files only, 8 KB read), turned into plain text,
 * redacted FIRST and then clipped to 80 (clipping first could cut a secret in half and defeat the redaction). README text is
 * untrusted and lands in prompts, so only a short H1 is used. No README or no usable H1 -> the dir name.
 */
export function describeDir(dir: string): string {
  for (const file of ["README.md", "README"]) {
    const h1 = firstH1(readHead(dir, file) ?? "");
    const clean = h1 === undefined ? "" : redactText(plain(h1)).slice(0, MAX_DESCRIPTION).trim();
    if (clean) return clean;
  }
  return basename(dir);
}
