import { expect, test } from "bun:test";
import { worthKeeping } from "../src/memory/worth-keeping";

const existing = ["Deploy uses Docker Compose on one VPS", "owner prefers short answers"];

test("a note that is too short to mean anything is refused", () => {
  expect(worthKeeping("ok", existing)).toBe("too_short");
  expect(worthKeeping("   dùng vim  ", existing)).toBe("too_short");
});

test("a note that is the same as an existing one, up to case, punctuation and one word, is refused", () => {
  expect(worthKeeping("deploy uses docker compose on one vps.", existing)).toBe("near_duplicate");
  expect(worthKeeping("Deploy uses Docker Compose on one single VPS", existing)).toBe(
    "near_duplicate",
  );
});

test("a different note is kept, also when it shares a few words", () => {
  expect(worthKeeping("owner reviews every pull request before merge", existing)).toBe("keep");
  expect(worthKeeping("Deploy needs a staging check first", existing)).toBe("keep");
});

test("Vietnamese notes compare without diacritics", () => {
  expect(
    worthKeeping("triển khai bằng docker compose trên một vps", [
      "trien khai bang Docker Compose tren mot VPS",
    ]),
  ).toBe("near_duplicate");
});
