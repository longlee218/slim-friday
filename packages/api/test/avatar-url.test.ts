import { expect, test } from "bun:test";
import { FakeFileStore } from "../../core/test/fakes/fake-file-store";
import { createAvatarUrls } from "../src/avatar-url";

const H = 3_600_000;
const t = (h: number, m: number) => 10 * 24 * H + h * H + m * 60_000;

/** A file store that counts presignGet calls. */
function counting() {
  const files = new FakeFileStore();
  let calls = 0;
  const real = files.presignGet.bind(files);
  files.presignGet = (k, e, o) => {
    calls++;
    return real(k, e, o);
  };
  return { files, calls: () => calls };
}

test("no avatar gives no url", () => {
  const { files } = counting();
  expect(createAvatarUrls(files, () => t(10, 5))(undefined)).toBeUndefined();
});

test("a preset is the web bundle's file, never presigned", () => {
  const { files, calls } = counting();
  expect(createAvatarUrls(files, () => t(10, 5))("designer")).toBe("/avatars/designer.webp");
  expect(calls()).toBe(0);
});

test("an upload without a key gives no url", () => {
  const { files } = counting();
  expect(createAvatarUrls(files, () => t(10, 5))("upload:abc")).toBeUndefined();
});

test("with a CDN the url is the CDN url and nothing is presigned", () => {
  const { files, calls } = counting();
  const url = createAvatarUrls(files, () => t(10, 5), "https://cdn.example.com");
  expect(url("upload:u1", "avatars/bots/dev/u 1.webp")).toBe(
    "https://cdn.example.com/avatars/bots/dev/u%201.webp",
  );
  expect(calls()).toBe(0);
});

test("a preset stays local even with a CDN", () => {
  const { files } = counting();
  expect(createAvatarUrls(files, () => t(10, 5), "https://cdn.example.com")("x")).toBe(
    "/avatars/x.webp",
  );
});

test("avatar URL is stable within the hour and changes after", () => {
  const { files, calls } = counting();
  let now = t(10, 5);
  const url = createAvatarUrls(files, () => now);
  const a = url("upload:u1", "avatars/bots/dev/u1.webp");
  now = t(10, 55);
  expect(url("upload:u1", "avatars/bots/dev/u1.webp")).toBe(a);
  expect(calls()).toBe(1);
  now = t(11, 1);
  const b = url("upload:u1", "avatars/bots/dev/u1.webp");
  expect(b).not.toBe(a);
  expect(calls()).toBe(2);
});

test("the link outlives the hour by one hour", () => {
  const { files } = counting();
  const url = createAvatarUrls(files, () => t(10, 30));
  // 30 min to the hour end + 1 h = 5400 s.
  expect(url("upload:u1", "k.webp")).toContain("exp=5400");
});

test("cache entries of a past hour are pruned on insert", () => {
  const { files } = counting();
  let now = t(10, 5);
  const url = createAvatarUrls(files, () => now);
  url("upload:a", "a.webp");
  now = t(11, 5);
  url("upload:b", "b.webp");
  now = t(10, 30); // clock back: a must have been dropped, so it presigns again
  const presign = files.presignGet.bind(files);
  let calls = 0;
  files.presignGet = (k, e, o) => (calls++, presign(k, e, o));
  url("upload:a", "a.webp");
  expect(calls).toBe(1);
});
