import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { floorCheck } from "../src/session/floor-check";

/** Real temp dir (macOS /var -> /private/var) so path comparisons are stable. */
const base = realpathSync(mkdtempSync(join(tmpdir(), "floor-")));
const ws = join(base, "ws");
const home = join(base, "home");
const scratch = join(home, "runs", "b1");
mkdirSync(ws, { recursive: true });
mkdirSync(scratch, { recursive: true });
const ctx = {
  writePaths: [ws, scratch],
  readPaths: [ws, scratch],
  agentHome: home,
  cwd: ws,
  allowInside: [scratch],
};

test("a read inside a workspace is allowed", () => {
  expect(floorCheck({ tool: "Read", input: { file_path: join(ws, "a.ts") } }, ctx)).toBeUndefined();
});

test("a read outside every workspace is denied", () => {
  expect(floorCheck({ tool: "Read", input: { file_path: "/etc/hosts" } }, ctx)).toBeString();
});

test("a sensitive file inside a workspace is denied", () => {
  expect(floorCheck({ tool: "Read", input: { file_path: join(ws, ".env") } }, ctx)).toBeString();
  expect(
    floorCheck({ tool: "Edit", input: { file_path: join(ws, "keys", "a.txt") } }, ctx),
  ).toBeString();
});

test("the agent home is denied even when a workspace contains it, except the run's scratch dir", () => {
  const wide = { ...ctx, writePaths: [base], readPaths: [base] };
  expect(
    floorCheck({ tool: "Read", input: { file_path: join(home, "data", "agent.db") } }, wide),
  ).toBeString();
  expect(floorCheck({ tool: "Write", input: { file_path: join(home, "x") } }, wide)).toBeString();
  expect(
    floorCheck({ tool: "Write", input: { file_path: join(scratch, "x") } }, wide),
  ).toBeUndefined();
});

test("a write outside the write paths is denied, a read of a read-only path is allowed", () => {
  const ro = { ...ctx, writePaths: [scratch], readPaths: [ws, scratch] };
  expect(floorCheck({ tool: "Write", input: { file_path: join(ws, "a") } }, ro)).toBeString();
  expect(floorCheck({ tool: "Read", input: { file_path: join(ws, "a") } }, ro)).toBeUndefined();
});

test("a relative path resolves against cwd", () => {
  expect(floorCheck({ tool: "Read", input: { file_path: "src/a.ts" } }, ctx)).toBeUndefined();
  expect(floorCheck({ tool: "Read", input: { file_path: "../outside.txt" } }, ctx)).toBeString();
});

test("Bash and MCP tools are left to the sandbox and the permission decision", () => {
  expect(floorCheck({ tool: "Bash", input: { command: "cat /etc/hosts" } }, ctx)).toBeUndefined();
  expect(floorCheck({ tool: "mcp__x__y", input: { path: "/etc/hosts" } }, ctx)).toBeUndefined();
});

test("Grep and Glob without a path search the cwd", () => {
  expect(floorCheck({ tool: "Grep", input: { pattern: "x" } }, ctx)).toBeUndefined();
  expect(floorCheck({ tool: "Glob", input: { pattern: "*.ts", path: "/etc" } }, ctx)).toBeString();
});

test("a dangling symlink inside a workspace is denied (it could point anywhere)", () => {
  symlinkSync(join(base, "nowhere", "x"), join(ws, "dangling"));
  expect(
    floorCheck({ tool: "Write", input: { file_path: join(ws, "dangling") } }, ctx),
  ).toBeString();
});

test("a Glob with an absolute pattern is checked by its base dir", () => {
  expect(floorCheck({ tool: "Glob", input: { pattern: "/etc/**/*.conf" } }, ctx)).toBeString();
  expect(floorCheck({ tool: "Glob", input: { pattern: `${home}/data/**` } }, ctx)).toBeString();
  expect(floorCheck({ tool: "Glob", input: { pattern: `${ws}/**/*.ts` } }, ctx)).toBeUndefined();
});
