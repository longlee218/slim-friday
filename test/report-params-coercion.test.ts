import { expect, test } from "bun:test";
import { createReportTool } from "../src/mcp/orchestration/tools/ReportTool/report-tool";
import { PROGRESS_NOTE_MAX_CHARS } from "../src/orchestrator/lead/lead-limits";
import type { ReportSink } from "../src/orchestrator/worker/report-sink";

/* `Report` input leniency: a bare-string request is a question; a long progress note is cut, not refused. */

function setup() {
  const sink: ReportSink = {} as ReportSink;
  const progress: { percent: number; note: string }[] = [];
  const tool = createReportTool({ sink, progress: (p) => progress.push(p) });
  const call = async (action: string, params: object) =>
    JSON.parse(
      ((await tool.handler({ action, params } as never, {})).content[0] as { text: string }).text,
    );
  return { sink, progress, call };
}

test("result: a plain-string request becomes a question; an object stays as is", async () => {
  const { sink, call } = setup();
  const r = await call("result", {
    title: "T",
    status: "COMPLETED",
    summary: "done",
    requests: ["Keep violet?", { kind: "capability", text: "needs a DB" }],
  });
  expect(r.ok).toBe(true);
  expect(sink.report?.requests).toEqual([
    { kind: "question", text: "Keep violet?" },
    { kind: "capability", text: "needs a DB" },
  ]);
});

test("result: an invalid request object and an over-long summary stay refused", async () => {
  const { call } = setup();
  expect(
    await call("result", {
      title: "T",
      status: "COMPLETED",
      summary: "s",
      requests: [{ kind: "x" }],
    }),
  ).toMatchObject({ code: "BAD_PARAMS" });
  expect(
    await call("result", { title: "T", status: "COMPLETED", summary: "s".repeat(4001) }),
  ).toMatchObject({ code: "BAD_PARAMS" });
});

test("progress: a note over the limit is cut to the limit", async () => {
  const { progress, call } = setup();
  const r = await call("progress", { percent: 10, note: "n".repeat(PROGRESS_NOTE_MAX_CHARS + 50) });
  expect(r.ok).toBe(true);
  expect(progress[0]?.note.length).toBe(PROGRESS_NOTE_MAX_CHARS);
});
