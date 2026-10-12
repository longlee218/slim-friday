import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";

let root: string;
let allowed: string;
let outside: string;
const ctx = () => ({ writePaths: [allowed] });

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
  [
    "write existing inside",
    WRITE_TOOL_NAME,
    () => ({ file_path: join(allowed, "real.txt") }),
    "allow",
  ],
  [
    "write new nested inside",
    WRITE_TOOL_NAME,
    () => ({ file_path: join(allowed, "a/b/c.ts") }),
    "allow",
  ],
  ["edit inside", EDIT_TOOL_NAME, () => ({ file_path: join(allowed, "sub/x.ts") }), "allow"],
  [
    "multiedit inside",
    MULTI_EDIT_TOOL_NAME,
    () => ({ file_path: join(allowed, "sub/x.ts") }),
    "allow",
  ],
  [
    "notebook inside",
    NOTEBOOK_EDIT_TOOL_NAME,
    () => ({ notebook_path: join(allowed, "n.ipynb") }),
    "allow",
  ],
  ["write the root itself", WRITE_TOOL_NAME, () => ({ file_path: allowed }), "allow"],
  ["write outside", WRITE_TOOL_NAME, () => ({ file_path: join(outside, "x.txt") }), "deny"],
  [
    "dotdot escape",
    WRITE_TOOL_NAME,
    () => ({ file_path: join(allowed, "../outside/x.txt") }),
    "deny",
  ],
  [
    "dotdot via missing dirs",
    WRITE_TOOL_NAME,
    () => ({ file_path: join(allowed, "n/../../x") }),
    "deny",
  ],
  [
    "dir symlink escape",
    WRITE_TOOL_NAME,
    () => ({ file_path: join(allowed, "dirlink/new.txt") }),
    "deny",
  ],
  ["file symlink escape", EDIT_TOOL_NAME, () => ({ file_path: join(allowed, "filelink") }), "deny"],
  ["dangling symlink", WRITE_TOOL_NAME, () => ({ file_path: join(allowed, "dangling") }), "deny"],
  [
    "name-prefix sibling",
    WRITE_TOOL_NAME,
    () => ({ file_path: join(`${allowed}-evil`, "x") }),
    "deny",
  ],
  [
    "notebook outside",
    NOTEBOOK_EDIT_TOOL_NAME,
    () => ({ notebook_path: join(outside, "n") }),
    "deny",
  ],
  ["missing path", WRITE_TOOL_NAME, () => ({}), "deny"],
  ["non-string path", EDIT_TOOL_NAME, () => ({ file_path: 42 }), "deny"],
  ["empty path", WRITE_TOOL_NAME, () => ({ file_path: "" }), "deny"],
  ["relative path", WRITE_TOOL_NAME, () => ({ file_path: "src/x.ts" }), "deny"],
  [
    "notebook needs notebook_path",
    NOTEBOOK_EDIT_TOOL_NAME,
    () => ({ file_path: join(allowed, "n") }),
    "deny",
  ],
  ["read normal file", READ_TOOL_NAME, () => ({ file_path: "/repo/src/index.ts" }), "allow"],
  ["read .env", READ_TOOL_NAME, () => ({ file_path: "/repo/.env" }), "deny"],
  ["read .env.local", READ_TOOL_NAME, () => ({ file_path: "/repo/.env.local" }), "deny"],
  ["read pem", READ_TOOL_NAME, () => ({ file_path: "/x/server.pem" }), "deny"],
  ["read key", READ_TOOL_NAME, () => ({ file_path: "/x/api.key" }), "deny"],
  ["read id_rsa", READ_TOOL_NAME, () => ({ file_path: "/home/u/.ssh/id_rsa" }), "deny"],
  ["read id_rsa.pub", READ_TOOL_NAME, () => ({ file_path: "/home/u/.ssh/id_rsa.pub" }), "deny"],
  ["read credentials", READ_TOOL_NAME, () => ({ file_path: "/x/credentials.json" }), "deny"],
  [
    "read symlink to .env",
    READ_TOOL_NAME,
    () => ({ file_path: join(allowed, "innocent.txt") }),
    "deny",
  ],
  ["glob normal", GLOB_TOOL_NAME, () => ({ pattern: "**/*.ts" }), "allow"],
  ["glob env pattern", GLOB_TOOL_NAME, () => ({ pattern: "**/.env*" }), "deny"],
  ["glob key pattern", GLOB_TOOL_NAME, () => ({ pattern: "**/*.key" }), "deny"],
  ["grep normal", GREP_TOOL_NAME, () => ({ pattern: "credentials", path: "/repo/src" }), "allow"],
  ["grep secret path", GREP_TOOL_NAME, () => ({ pattern: "x", path: "/repo/.env" }), "deny"],
  ["grep secret glob", GREP_TOOL_NAME, () => ({ pattern: "x", glob: "*.pem" }), "deny"],
  [ASK_USER_QUESTION_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME, () => ({}), "allow"],
  ["unknown tool", WEB_FETCH_TOOL_NAME, () => ({ url: "https://x" }), "ask"],
];

describe("file tool guardrails", () => {
  test.each(rows)("%s", (_label, tool, input, expected) => {
    expect(checkToolCall(tool, input(), ctx()).decision).toBe(expected);
  });

  test("empty writePaths denies every write", () => {
    const input = { file_path: join(allowed, "real.txt") };
    expect(checkToolCall(WRITE_TOOL_NAME, input, { writePaths: [] }).decision).toBe("deny");
  });

  test("multiple allowed roots", () => {
    const c = { writePaths: [join(root, "none"), outside] };
    expect(checkToolCall(WRITE_TOOL_NAME, { file_path: join(outside, "n.txt") }, c).decision).toBe(
      "allow",
    );
  });
});

describe("read paths and secret dotfiles", () => {
  const readCtx = () => ({ writePaths: [allowed], readPaths: [allowed] });
  const d = (tool: string, input: Record<string, unknown>) =>
    checkToolCall(tool, input, readCtx()).decision;

  test("reads: inside allowed dirs ok; outside, symlink escape and absolute/parent globs denied", () => {
    expect(d(READ_TOOL_NAME, { file_path: join(allowed, "real.txt") })).toBe("allow");
    expect(d(READ_TOOL_NAME, { file_path: join(outside, "target.txt") })).toBe("deny");
    expect(d(READ_TOOL_NAME, { file_path: join(allowed, "dirlink", "target.txt") })).toBe("deny");
    expect(d(READ_TOOL_NAME, { file_path: "/etc/hosts" })).toBe("deny");
    expect(d(READ_TOOL_NAME, { file_path: join(allowed, "../x") })).toBe("deny");
    expect(d(GREP_TOOL_NAME, { pattern: "x", path: outside })).toBe("deny");
    expect(d(GREP_TOOL_NAME, { pattern: "x" })).toBe("allow"); // defaults to cwd
    expect(d(GLOB_TOOL_NAME, { pattern: "/Users/**/*.json" })).toBe("deny");
    expect(d(GLOB_TOOL_NAME, { pattern: "../**" })).toBe("deny");
    expect(d(GLOB_TOOL_NAME, { pattern: "src/**/*.ts" })).toBe("allow");
  });

  test("dotfile credentials are denied even inside allowed dirs", () => {
    for (const f of [".credentials.json", ".npmrc", ".netrc", ".pgpass", "cert.p12"]) {
      expect(d(READ_TOOL_NAME, { file_path: join(allowed, f) })).toBe("deny");
    }
  });
});
