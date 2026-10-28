import { expect, test } from "bun:test";
import { formatSnapshot } from "../../src/computer/browser/page-snapshot";

const base = { url: "https://example.com/", title: "Example", text: "hello" };

test("caps at 80 elements and prints refs as p<gen>:<i>", () => {
  const elements = Array.from({ length: 120 }, (_, i) => ({ i, role: "button", name: `b${i}` }));
  const out = formatSnapshot({ ...base, elements }, 3);
  expect(out).toContain('[p3:7] button "b7"');
  expect(out).toContain("[p3:79]");
  expect(out).not.toContain("[p3:80]");
  expect(out).toContain("80 of 120");
});

test("never prints a password value", () => {
  const out = formatSnapshot(
    { ...base, elements: [{ i: 0, role: "password", name: "Password", value: "hunter2" }] },
    1,
  );
  expect(out).not.toContain("hunter2");
  expect(out).toContain("[p1:0] password");
});

test("prints a normal field value and truncates long text", () => {
  const out = formatSnapshot(
    {
      ...base,
      text: "x".repeat(5000),
      elements: [{ i: 0, role: "textbox", name: "Email", value: "a@b.c" }],
    },
    2,
  );
  expect(out).toContain('value="a@b.c"');
  expect(out).toContain("[text cut]");
  expect(out.length).toBeLessThan(4400);
});
