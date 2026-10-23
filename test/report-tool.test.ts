import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServers } from "../src/mcp/mcp-servers";
import { ORCHESTRATION_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { REPORT_TOOL } from "../src/mcp/orchestration/tools/ReportTool/constants";
import { createReportTool } from "../src/mcp/orchestration/tools/ReportTool/report-tool";
import type { ReportSink } from "../src/orchestrator/worker/report-sink";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { ROLES } from "../src/roles/role-registry";
import { FULL_CTX, toolsByServer } from "./mcp-ctx-fixture";

/* The worker's `Report` tool: `progress` feeds the run's progress port, `result` fills the sink (refusals as before);
   worker roles only (the lead has no ctx part). */

/** Call the tool; returns the parsed reply and the error flag. */
async function call(t: ReturnType<typeof createReportTool>, action: string, params: object) {
  const r = await t.handler({ action, params } as never, {});
  return { ...JSON.parse((r.content[0] as { text: string }).text), isError: r.isError };
}

test("progress passes percent and note to the run's progress port", async () => {
  const seen: { percent: number; note: string }[] = [];
  const t = createReportTool({ progress: (p) => void seen.push(p) });
  const res = await call(t, "progress", { percent: 30, note: "tests written" });
  expect(res.ok).toBe(true);
  expect(seen).toEqual([{ percent: 30, note: "tests written" }]);
});

test("progress params are bounded: whole percent 0-100, non-empty note (BAD_PARAMS); a note over 200 chars is cut, not refused", async () => {
  const t = createReportTool({ progress: () => {} });
  for (const bad of [
    { percent: 101, note: "a" },
    { percent: -1, note: "a" },
    { percent: 5.5, note: "a" },
    { percent: 5, note: "" },
  ])
    expect((await call(t, "progress", bad)).code).toBe("BAD_PARAMS");
  expect((await call(t, "progress", { percent: 5, note: "x".repeat(201) })).ok).toBe(true);
});

test("an action refuses with ACTION_UNAVAILABLE when the run lacks its part", async () => {
  const noPort = createReportTool({ sink: {} });
  expect((await call(noPort, "progress", { percent: 1, note: "a" })).code).toBe(
    "ACTION_UNAVAILABLE",
  );
  const noSink = createReportTool({ progress: () => {} });
  const r = await call(noSink, "result", { title: "T", status: "COMPLETED", summary: "s" });
  expect(r.code).toBe("ACTION_UNAVAILABLE");
});

test("result stores the first report; a second is ALREADY_REPORTED; files need a place to read from", async () => {
  const sink: ReportSink = {};
  const t = createReportTool({ sink });
  const body = { title: "T", status: "COMPLETED", summary: "done" };
  expect((await call(t, "result", body)).ok).toBe(true);
  expect(sink.report?.status).toBe("COMPLETED");
  const again = await call(t, "result", { ...body, status: "FAILED" });
  expect(again).toMatchObject({ isError: true, code: "ALREADY_REPORTED" });
  expect(sink.report?.status).toBe("COMPLETED");
  const fresh = createReportTool({ sink: {} });
  const noFiles = await call(fresh, "result", { ...body, files: [{ title: "x", path: "x.md" }] });
  expect(noFiles.code).toBe("INVALID_FILES");
});

test("worker roles hold Report when the run has a progress port or a sink; the lead never does", () => {
  for (const supply of [{ progress: () => {} }, { reportSink: {} }])
    for (const n of ["developer", "scout", "tester"])
      expect(toolsByServer(buildServers(ROLES[n]!, supply))[ORCHESTRATION_MCP_SERVER]).toContain(
        REPORT_TOOL,
      );
  expect(
    toolsByServer(buildServers(ROLES.lead!, { ...FULL_CTX, progress: undefined }))[
      ORCHESTRATION_MCP_SERVER
    ] ?? [],
  ).not.toContain(REPORT_TOOL);
  expect(ROLES.lead?.mcpTools).not.toContain(REPORT_TOOL);
});

test("the guard allows Report for every worker role and denies it for the others", () => {
  const full = `mcp__${ORCHESTRATION_MCP_SERVER}__${REPORT_TOOL}`;
  for (const [name, role] of Object.entries(ROLES))
    expect([
      name,
      checkToolCall(full, {}, guardFor(role, { readPaths: ["/r"] })).decision === "allow",
    ]).toEqual([name, role.kind === "worker"]);
});

test("result files: a scratch file is checked and copied into the sink; a bad one refuses the report", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "report-files-tool-")));
  try {
    const scratch = join(base, "scratch");
    mkdirSync(scratch);
    writeFileSync(join(scratch, "notes.md"), "# notes");
    const home = join(base, "home");
    mkdirSync(home);
    const files = { home, copyDir: join(home, "task-files", "g", "t") };
    const body = { title: "T", status: "COMPLETED", summary: "done" };
    const bad: ReportSink = {};
    const refused = await call(
      createReportTool({ sink: bad, files, scratchDir: scratch }),
      "result",
      {
        ...body,
        files: [{ title: "x", path: "../escape.md" }],
      },
    );
    expect(refused).toMatchObject({ isError: true, code: "INVALID_FILES" });
    expect(bad.report).toBeUndefined();
    const sink: ReportSink = {};
    const ok = await call(createReportTool({ sink, files, scratchDir: scratch }), "result", {
      ...body,
      files: [{ title: "Notes", path: "notes.md" }],
    });
    expect(ok.ok).toBe(true);
    expect(sink.files).toEqual([
      { title: "Notes", base: "scratch", path: join(home, "task-files", "g", "t", "1-notes.md") },
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("result files: an image refusal keeps no copy and no files, so the worker can report again", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "report-files-img-")));
  try {
    const scratch = join(base, "scratch");
    mkdirSync(scratch);
    writeFileSync(join(scratch, "notes.md"), "# notes");
    const home = join(base, "home");
    mkdirSync(home);
    const files = { home, copyDir: join(home, "task-files", "g", "t") };
    const sink: ReportSink = {};
    const tool = createReportTool({ sink, files, scratchDir: scratch });
    const body = { title: "T", status: "COMPLETED", summary: "done" };
    const refused = await call(tool, "result", {
      ...body,
      files: [{ title: "Notes", path: "notes.md" }],
      images: ["missing.png"],
    });
    expect(refused).toMatchObject({ isError: true, code: "INVALID_IMAGES" });
    expect(sink.files).toBeUndefined();
    expect(existsSync(files.copyDir)).toBe(false);
    const again = await call(tool, "result", {
      ...body,
      files: [{ title: "Notes", path: "notes.md" }],
    });
    expect(again.ok).toBe(true);
    expect(sink.files).toHaveLength(1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
