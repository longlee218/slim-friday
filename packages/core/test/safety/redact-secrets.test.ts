import { expect, test } from "bun:test";
import { REDACTED, redactSecrets, redactValue } from "../../src/safety/redact-secrets";

const cases: [string, string][] = [
  ["sk", "key sk-abcdefghijklmnop1234 end"],
  ["ghp", "t ghp_abcdefghijklmnopqrst1234 end"],
  ["github_pat", "t github_pat_abcdefghijklmnopqrst1234 end"],
  ["AKIA", "id AKIAABCDEFGHIJKLMNOP end"],
  ["slack", "t xoxb-1234567890-abcdef end"],
  ["pem", "k -----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY----- end"],
];

for (const [name, text] of cases) {
  test(`pattern ${name} is redacted`, () => {
    expect(redactSecrets(text, [])).toContain(REDACTED);
    expect(redactSecrets(text, [])).toEndWith(" end");
  });
}

test("a configured value is redacted wherever it appears", () => {
  expect(redactSecrets("a hunter2-secret b hunter2-secret", ["hunter2-secret"])).toBe(
    `a ${REDACTED} b ${REDACTED}`,
  );
});

test("a 7-char value is not redacted, an 8-char one is", () => {
  expect(redactSecrets("x abcdefg y", ["abcdefg"])).toBe("x abcdefg y");
  expect(redactSecrets("x abcdefgh y", ["abcdefgh"])).toBe(`x ${REDACTED} y`);
});

test("plain text is unchanged", () => {
  expect(redactSecrets("hello world", ["abcdefgh"])).toBe("hello world");
});

test("redactSecrets never throws", () => {
  expect(redactSecrets("x", null as unknown as string[])).toBe("[redaction failed]");
});

test("redactValue redacts nested strings and leaves other values", () => {
  expect(
    redactValue({ a: ["abcdefgh", 1], b: { c: "x abcdefgh" }, d: null }, ["abcdefgh"]),
  ).toEqual({ a: [REDACTED, 1], b: { c: `x ${REDACTED}` }, d: null });
});
