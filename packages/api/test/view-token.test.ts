import { expect, test } from "bun:test";
import { openViewToken, sealViewToken, type ViewClaims } from "../src/computer/view-token";

const SECRET = "s".repeat(32);
const claims: ViewClaims = { computer: "c1", botId: "b1", port: 4100, exp: 2000, mode: "view" };

test("round trip returns the claims", () => {
  expect(openViewToken(SECRET, sealViewToken(SECRET, claims), 1000)).toEqual(claims);
});

test("tampered body, wrong secret, expired and malformed tokens are refused", () => {
  const t = sealViewToken(SECRET, claims);
  const [body, mac] = t.split(".") as [string, string];
  const forged = Buffer.from(JSON.stringify({ ...claims, port: 22 })).toString("base64url");
  expect(openViewToken(SECRET, `${forged}.${mac}`, 1000)).toBeUndefined();
  expect(openViewToken(SECRET, `${body}.x${mac}`, 1000)).toBeUndefined();
  expect(openViewToken("o".repeat(32), t, 1000)).toBeUndefined();
  expect(openViewToken(SECRET, t, 2000)).toBeUndefined();
  expect(openViewToken(SECRET, "nope", 1000)).toBeUndefined();
  expect(openViewToken(SECRET, "", 1000)).toBeUndefined();
});
