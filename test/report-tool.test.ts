import { expect, test } from "bun:test";
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

test("progress params are bounded: whole percent 0-100, note 1-200 chars (BAD_PARAMS)", async () => {
  const t = createReportTool({ progress: () => {} });
  for (const bad of [
    { percent: 101, note: "a" },
    { percent: -1, note: "a" },
    { percent: 5.5, note: "a" },
    { percent: 5, note: "" },
    { percent: 5, note: "x".repeat(201) },
  ])
    expect((await call(t, "progress", bad)).code).toBe("BAD_PARAMS");
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

test("result stores the first report; a second is ALREADY_REPORTED; artifacts need an artifact ctx", async () => {
  const sink: ReportSink = {};
  const t = createReportTool({ sink });
  const body = { title: "T", status: "COMPLETED", summary: "done" };
  expect((await call(t, "result", body)).ok).toBe(true);
  expect(sink.report?.status).toBe("COMPLETED");
  const again = await call(t, "result", { ...body, status: "FAILED" });
  expect(again).toMatchObject({ isError: true, code: "ALREADY_REPORTED" });
  expect(sink.report?.status).toBe("COMPLETED");
  const fresh = createReportTool({ sink: {} });
  const noArt = await call(fresh, "result", { ...body, artifacts: [{ id: "x" }] });
  expect(noArt.code).toBe("INVALID_ARTIFACTS");
});

test("worker roles hold Report when the run has a progress port or a sink; the lead never does", () => {
  for (const supply of [{ progress: () => {} }, { reportSink: {} }])
    for (const n of ["developer", "scout", "planner", "tester"])
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
