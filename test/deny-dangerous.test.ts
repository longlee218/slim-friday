import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall } from "../src/guardrails/check-tool-call";

let root: string;
let allowed: string;
let outside: string;
const ctx = () => ({ allowedPaths: [allowed] });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "guardrails-")));
  allowed = join(root, "task");
  outside = join(root, "outside");
  mkdirSync(join(allowed, "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "target.txt"), "x");
  writeFileSync(join(allowed, "real.txt"), "x");
  symlinkSync(outside, join(allowed, "dirlink")); // dir symlink escaping the root
  symlinkSync(join(outside, "target.txt"), join(allowed, "filelink")); // file symlink escape
  symlinkSync(join(outside, "nope"), join(allowed, "dangling")); // dangling symlink
  mkdirSync(`${allowed}-evil`); // sibling sharing a name prefix
  writeFileSync(join(allowed, ".env"), "SECRET=1");
  symlinkSync(join(allowed, ".env"), join(allowed, "innocent.txt"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** [label, tool, input builder, expected] */
type Row = [string, string, () => Record<string, unknown>, "allow" | "ask" | "deny"];

const rows: Row[] = [
  ["write existing inside", "Write", () => ({ file_path: join(allowed, "real.txt") }), "allow"],
  ["write new nested inside", "Write", () => ({ file_path: join(allowed, "a/b/c.ts") }), "allow"],
  ["edit inside", "Edit", () => ({ file_path: join(allowed, "sub/x.ts") }), "allow"],
  ["multiedit inside", "MultiEdit", () => ({ file_path: join(allowed, "sub/x.ts") }), "allow"],
  ["notebook inside", "NotebookEdit", () => ({ notebook_path: join(allowed, "n.ipynb") }), "allow"],
  ["write the root itself", "Write", () => ({ file_path: allowed }), "allow"],
  ["write outside", "Write", () => ({ file_path: join(outside, "x.txt") }), "deny"],
  ["dotdot escape", "Write", () => ({ file_path: join(allowed, "../outside/x.txt") }), "deny"],
  ["dotdot via missing dirs", "Write", () => ({ file_path: join(allowed, "n/../../x") }), "deny"],
  ["dir symlink escape", "Write", () => ({ file_path: join(allowed, "dirlink/new.txt") }), "deny"],
  ["file symlink escape", "Edit", () => ({ file_path: join(allowed, "filelink") }), "deny"],
  ["dangling symlink", "Write", () => ({ file_path: join(allowed, "dangling") }), "deny"],
  ["name-prefix sibling", "Write", () => ({ file_path: join(`${allowed}-evil`, "x") }), "deny"],
  ["notebook outside", "NotebookEdit", () => ({ notebook_path: join(outside, "n") }), "deny"],
  ["missing path", "Write", () => ({}), "deny"],
  ["non-string path", "Edit", () => ({ file_path: 42 }), "deny"],
  ["empty path", "Write", () => ({ file_path: "" }), "deny"],
  ["relative path", "Write", () => ({ file_path: "src/x.ts" }), "deny"],
  [
    "notebook needs notebook_path",
    "NotebookEdit",
    () => ({ file_path: join(allowed, "n") }),
    "deny",
  ],
  ["read normal file", "Read", () => ({ file_path: "/repo/src/index.ts" }), "allow"],
  ["read .env", "Read", () => ({ file_path: "/repo/.env" }), "deny"],
  ["read .env.local", "Read", () => ({ file_path: "/repo/.env.local" }), "deny"],
  ["read pem", "Read", () => ({ file_path: "/x/server.pem" }), "deny"],
  ["read key", "Read", () => ({ file_path: "/x/api.key" }), "deny"],
  ["read id_rsa", "Read", () => ({ file_path: "/home/u/.ssh/id_rsa" }), "deny"],
  ["read id_rsa.pub", "Read", () => ({ file_path: "/home/u/.ssh/id_rsa.pub" }), "deny"],
  ["read credentials", "Read", () => ({ file_path: "/x/credentials.json" }), "deny"],
  ["read symlink to .env", "Read", () => ({ file_path: join(allowed, "innocent.txt") }), "deny"],
  ["glob normal", "Glob", () => ({ pattern: "**/*.ts" }), "allow"],
  ["glob env pattern", "Glob", () => ({ pattern: "**/.env*" }), "deny"],
  ["glob key pattern", "Glob", () => ({ pattern: "**/*.key" }), "deny"],
  ["grep normal", "Grep", () => ({ pattern: "credentials", path: "/repo/src" }), "allow"],
  ["grep secret path", "Grep", () => ({ pattern: "x", path: "/repo/.env" }), "deny"],
  ["grep secret glob", "Grep", () => ({ pattern: "x", glob: "*.pem" }), "deny"],
  ["ExitPlanMode", "ExitPlanMode", () => ({ plan: "p" }), "allow"],
  ["AskUserQuestion", "AskUserQuestion", () => ({}), "allow"],
  ["EnterPlanMode", "EnterPlanMode", () => ({}), "allow"],
  ["unknown tool", "WebFetch", () => ({ url: "https://x" }), "ask"],
];

describe("file tool guardrails", () => {
  test.each(rows)("%s", (_label, tool, input, expected) => {
    expect(checkToolCall(tool, input(), ctx()).decision).toBe(expected);
  });

  test("empty allowedPaths denies every write", () => {
    const input = { file_path: join(allowed, "real.txt") };
    expect(checkToolCall("Write", input, { allowedPaths: [] }).decision).toBe("deny");
  });

  test("multiple allowed roots", () => {
    const c = { allowedPaths: [join(root, "none"), outside] };
    expect(checkToolCall("Write", { file_path: join(outside, "n.txt") }, c).decision).toBe("allow");
  });
});
