import { expect, test } from "bun:test";
import { inputPreview, scrubEditError } from "../src/observability/tool-input-preview";

test("file content keys become <N chars> (Write, Edit, NotebookEdit, MultiEdit)", () => {
  const p = inputPreview({
    file_path: "/a/b.ts",
    content: "CONTENT-BODY",
    old_string: "OLD-BODY",
    new_string: "NEW-BODY",
    new_source: "NB-BODY",
    edits: [{ old_string: "NESTED-OLD", new_string: "NESTED-NEW" }],
  });
  for (const b of ["CONTENT-BODY", "OLD-BODY", "NEW-BODY", "NB-BODY", "NESTED-OLD", "NESTED-NEW"])
    expect(p).not.toContain(b);
  expect(p).toContain("<12 chars>");
  expect(p).toContain("/a/b.ts");
});

test("other inputs are previewed and still redacted", () => {
  const p = inputPreview({ command: "echo password: hunter2" });
  expect(p).toContain("echo");
  expect(p).not.toContain("hunter2");
});

test("edit error: first line only, echoed old_string cut out", () => {
  const input = { file_path: "a.ts", old_string: "const secretValue = 42;" };
  const err =
    "String to replace not found const secretValue = 42;\nString: const secretValue = 42;";
  const out = scrubEditError(err, input);
  expect(out).not.toContain("secretValue");
  expect(out).not.toContain("\n");
  expect(out).toContain("String to replace not found");
});
