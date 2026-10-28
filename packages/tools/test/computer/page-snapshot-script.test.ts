import { expect, test } from "bun:test";
import { formatSnapshot } from "../../src/computer/browser/page-snapshot";
import { PAGE_SNAPSHOT_SCRIPT } from "../../src/computer/browser/page-snapshot-script";

interface FakeEl {
  tag: string;
  type?: string;
  role?: string;
  value?: string;
  text?: string;
}

/** Run the script against a tiny hand-made DOM (no DOM library in the repo's tools package). */
function run(els: FakeEl[], gen = 4) {
  const nodes = els.map((e) => ({
    tagName: e.tag.toUpperCase(),
    type: e.type,
    value: e.value ?? "",
    innerText: e.text ?? "",
    isContentEditable: false,
    getAttribute: (n: string) => (n === "role" ? (e.role ?? null) : null),
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
  }));
  const globals = {
    document: {
      querySelectorAll: () => nodes,
      title: "T",
      body: { innerText: "body" },
    },
    location: { href: "https://example.com/" },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    globalThis: {} as Record<string, unknown>,
  };
  const fn = new Function(...Object.keys(globals), `return (${PAGE_SNAPSHOT_SCRIPT})`)(
    ...Object.values(globals),
  );
  return fn(gen);
}

test("the script parses and returns the raw shape", () => {
  const raw = run([{ tag: "button", text: "Go" }]);
  expect(raw).toMatchObject({ url: "https://example.com/", title: "T", text: "body" });
  expect(raw.elements[0]).toMatchObject({ i: 0, role: "button", name: "Go" });
});

test("a password input with a page-set role is flagged secret and its value is never returned", () => {
  const raw = run([{ tag: "input", type: "password", role: "textbox", value: "hunter2" }]);
  expect(raw.elements[0].secret).toBe(true);
  expect(raw.elements[0].value).toBeUndefined();
  expect(JSON.stringify(raw)).not.toContain("hunter2");
  expect(formatSnapshot(raw, 4)).not.toContain("hunter2");
});

test("formatSnapshot masks any secret element even with a plain role and a value", () => {
  const out = formatSnapshot(
    {
      url: "u",
      title: "t",
      text: "",
      elements: [{ i: 0, role: "textbox", name: "pw", value: "hunter2", secret: true }],
    },
    1,
  );
  expect(out).not.toContain("hunter2");
  expect(out).toContain("[hidden]");
});
