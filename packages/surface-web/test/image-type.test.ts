import { expect, test } from "bun:test";
import { imageType } from "../src/image-type";
import { safeName } from "../src/safe-name";

const bytes = (...b: number[]) => new Uint8Array(b);

test("imageType reads magic bytes, a renamed text file is not an image", () => {
  expect(imageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d))).toBe("image/png");
  expect(imageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
  expect(imageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(imageType(new TextEncoder().encode("GIF89a.."))).toBe("image/gif");
  expect(imageType(new TextEncoder().encode("GIF87a.."))).toBe("image/gif");
  expect(imageType(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBeUndefined();
  expect(imageType(new TextEncoder().encode("hello.png"))).toBeUndefined();
  expect(imageType(bytes())).toBeUndefined();
});

test("safeName keeps the last part, replaces odd chars, cuts to 100, never empty", () => {
  expect(safeName("../../etc/chart one.png")).toBe("chart_one.png");
  expect(safeName("a\\b\\c d.txt")).toBe("c_d.txt");
  expect(safeName("x".repeat(150))).toHaveLength(100);
  expect(safeName("")).toBe("file");
  expect(safeName("dir/")).toBe("file");
  for (const dots of ["..", ".", "a/..", "...", "x/."]) expect(safeName(dots)).toBe("file");
});
