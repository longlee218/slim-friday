import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IMAGE_MIME_TYPES } from "@friday/core";
import { isImageType } from "@friday/surface-web";

/** The web copy is a .tsx module the root tsconfig cannot import, so its list is read from source. */
function webImageTypes(): string[] {
  const src = readFileSync(
    new URL("../../web/src/components/files/file-preview.tsx", import.meta.url),
    "utf8",
  );
  const list = /const IMAGE_TYPES = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

test("core, surface-web and the web preview list the same image types", () => {
  const core = [...IMAGE_MIME_TYPES].sort();
  expect(webImageTypes().sort()).toEqual(core);
  expect(core.every(isImageType)).toBe(true);
  for (const other of ["image/svg+xml", "image/heic", "image/bmp", "application/pdf"])
    expect(isImageType(other)).toBe(false);
});
