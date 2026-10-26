import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBootState } from "../src/lifecycle/boot-checks";
import { checkTools } from "../src/lifecycle/tool-check";
import { captureLogs } from "../src/observability/logger";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "friday-toolcheck-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("checkTools warns for uvx and pdftotext with an install hint when both are missing", () => {
  const warnings = checkTools(() => null);
  expect(warnings.map((w) => w.tool)).toEqual(["uvx", "pdftotext"]);
  expect(warnings[0]?.hint).toContain("brew install uv");
  expect(warnings[1]?.hint).toContain("brew install poppler");
});

test("checkTools returns nothing when both tools are found", () => {
  expect(checkTools((name) => `/bin/${name}`)).toEqual([]);
});

test("checkTools warns only for the missing tool", () => {
  const warnings = checkTools((name) => (name === "uvx" ? "/bin/uvx" : null));
  expect(warnings.map((w) => w.tool)).toEqual(["pdftotext"]);
});

test("loadBootState still returns a state when both tools are missing", () => {
  const state = loadBootState({ AGENT_HOME: home, CLAUDE_CODE_OAUTH_TOKEN: "tok" }, () => null);
  expect(state.config.agentHome).toBe(home);
  expect(state.toolWarnings.map((w) => w.tool)).toEqual(["uvx", "pdftotext"]);
});

test("checkTools logs one warn per missing tool carrying the tool name only", () => {
  const cap = captureLogs();
  try {
    checkTools(() => null);
  } finally {
    cap.stop();
  }
  const warns = cap.lines.filter((l) => l.module === "tool-check");
  expect(warns).toHaveLength(2);
  for (const [i, tool] of ["uvx", "pdftotext"].entries()) {
    expect(warns[i]).toMatchObject({ level: 40, msg: "tool.missing", tool });
    expect(warns[i]).not.toHaveProperty("hint");
  }
});
