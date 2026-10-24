import { afterEach, expect, test, vi } from "vitest";
import {
  cropSquare,
  encodeAvatar,
  outputSize,
  TOO_LARGE,
} from "../../src/components/settings/encode-avatar";

afterEach(() => vi.unstubAllGlobals());

/** A fake canvas whose `toBlob` answers per requested type. */
const fakeCanvas = (answer: (type: string) => Blob) => () =>
  ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (cb: (b: Blob) => void, type: string) => cb(answer(type)),
  }) as unknown as HTMLCanvasElement;

const stubBitmap = (w: number, h: number) =>
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: w, height: h }));
const file = new File(["x"], "a.png", { type: "image/png" });

test("cropSquare centres the crop on the longer side", () => {
  expect(cropSquare(800, 600)).toEqual({ sx: 100, sy: 0, size: 600 });
  expect(cropSquare(600, 800)).toEqual({ sx: 0, sy: 100, size: 600 });
});

test("outputSize caps at 512", () => {
  expect(outputSize(2000)).toBe(512);
  expect(outputSize(300)).toBe(300);
});

test("Safari: a PNG answer for webp is re-encoded as jpeg, never labelled webp", async () => {
  stubBitmap(800, 600);
  const make = fakeCanvas((t) => new Blob(["b"], { type: t === "image/webp" ? "image/png" : t }));
  const out = await encodeAvatar(file, make);
  expect(out.type).toBe("image/jpeg");
  expect(out.blob.type).toBe("image/jpeg");
});

test("webp is kept when the browser encodes it", async () => {
  stubBitmap(800, 600);
  const out = await encodeAvatar(
    file,
    fakeCanvas((t) => new Blob(["b"], { type: t })),
  );
  expect(out.type).toBe("image/webp");
});

test("a result over 2 MB throws too large", async () => {
  stubBitmap(800, 600);
  const big = new Blob([new Uint8Array(3 * 1024 * 1024)], { type: "image/webp" });
  await expect(
    encodeAvatar(
      file,
      fakeCanvas(() => big),
    ),
  ).rejects.toThrow(TOO_LARGE);
});
