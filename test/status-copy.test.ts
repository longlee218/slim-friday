import { expect, test } from "bun:test";
import { renderStatus } from "../src/ingress/status-copy";
import type { StatusFacts } from "../src/orchestrator/turns/status-snapshot";

/* `/status` wording: rendered from facts by app code (en / vi), no model. */

const running: StatusFacts = {
  running: true,
  role: "developer",
  state: "running",
  seconds: 125,
  toolCount: 2,
  recent: [{ tool: "Bash", description: "run tests" }, { tool: "Read" }],
  note: "fixing the bug",
};

test("nothing running: one line in both languages", () => {
  expect(renderStatus(undefined, "en")).toBe("Nothing is running.");
  expect(renderStatus(undefined, "vi")).toBe("Không có việc nào đang chạy.");
});

test("running task: role, state, time, tools, latest note; no approval line without one", () => {
  const out = renderStatus(running, "en");
  expect(out).toContain("Running (developer, running) for 2m.");
  expect(out).toContain("2 tools so far, latest:");
  expect(out).toContain("- Bash: run tests");
  expect(out).toContain("- Read");
  expect(out).toContain("Latest note: fixing the bug");
  expect(out).not.toContain("approval");
});

test("running task waiting on an approval says which tool and for how long", () => {
  const out = renderStatus({ ...running, waiting: { tool: "Bash", seconds: 30 } }, "en");
  expect(out).toContain("Waiting for your approval of Bash (30s).");
});

test("waiting task (stopped): role, status, scope, how long ago", () => {
  const out = renderStatus(
    {
      running: false,
      role: "developer",
      taskStatus: "waiting_user",
      scope: "add b.txt",
      seconds: 7200,
      toolCount: 0,
      recent: [],
    },
    "en",
  );
  expect(out).toContain("Waiting task (developer, waiting_user), stopped 2h ago.");
  expect(out).toContain("Scope: add b.txt");
  expect(out).toContain("No tools used yet.");
});

test("Vietnamese wording", () => {
  const out = renderStatus(running, "vi");
  expect(out).toContain("Đang chạy (developer, running) được 2m.");
  expect(out).toContain("Ghi chú mới nhất: fixing the bug");
});
