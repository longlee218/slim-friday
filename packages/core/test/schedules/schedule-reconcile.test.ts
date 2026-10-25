import { expect, test } from "bun:test";
import { addSchedule, HOUR, MIN, makeBoard, putWake, runsOf, T0 } from "./schedule-harness";

test("reconcile settles open rows from their wakes", async () => {
  const h = makeBoard();
  const cases: [string, Parameters<typeof putWake>[2] | undefined, object, string?][] = [
    ["done", "done", { status: "ok" }],
    ["fail", "failed", { status: "failed", error: "boom" }, 'Schedule "Brief" failed: boom'],
    ["cancel", "cancelled", { status: "failed", error: "Run cancelled." }],
    [
      "int",
      "interrupted",
      { status: "failed", error: "Run interrupted." },
      'Schedule "Brief" failed: Run interrupted.',
    ],
    ["missing", undefined, { status: "failed", error: "Run record expired." }],
    ["busy", "running", { status: "running" }],
  ];
  for (const [id, status, want, notice] of cases) {
    const s = await addSchedule(h);
    await h.store.scheduleRuns.insert({
      id: `r-${id}`,
      scheduleId: s.id,
      dueAt: T0,
      firedAt: T0,
      manual: true,
      late: false,
      status: "running",
      wakeId: `wk-${id}`,
      costUsd: 0,
    });
    if (status) putWake(h, `wk-${id}`, status, { endedAt: T0 + 5, error: "boom" });
    const before = h.tells.length;
    await h.board.tick();
    const [row] = await runsOf(h, s.id);
    expect(row).toMatchObject(want);
    if (status && status !== "running") expect(row?.endedAt).toBe(T0 + 5);
    if (!status) expect(row?.endedAt).toBe(T0);
    if (notice) expect(h.tells.slice(before).map((t) => t.text)).toEqual([notice]);
    else if (id !== "missing") expect(h.tells.length).toBe(before);
  }
});

test("reconcile: a problems schedule with a posted answer is a problem; silence is ok", async () => {
  const h = makeBoard();
  for (const [id, text, want] of [
    ["a", "The build is red.", "problem"],
    ["b", "NO_RESPONSE", "ok"],
    ["c", undefined, "ok"],
  ] as const) {
    const s = await addSchedule(h, undefined, { notify: "problems" });
    await h.store.scheduleRuns.insert({
      id: `r-${id}`,
      scheduleId: s.id,
      dueAt: T0,
      firedAt: T0,
      manual: true,
      late: false,
      status: "running",
      wakeId: `wk-${id}`,
      costUsd: 0,
    });
    putWake(h, `wk-${id}`, "done", text ? { resultText: text } : {});
    await h.board.tick();
    expect((await runsOf(h, s.id))[0]?.status).toBe(want);
  }
});

/** Insert an open history row of `scheduleId` fired at `firedAt` (no wake unless given). */
async function openRow(
  h: ReturnType<typeof makeBoard>,
  id: string,
  scheduleId: string,
  firedAt: number,
  wakeId?: string,
) {
  await h.store.scheduleRuns.insert({
    id,
    scheduleId,
    dueAt: firedAt,
    firedAt,
    manual: false,
    late: false,
    status: "running",
    ...(wakeId && { wakeId }),
    costUsd: 0,
  });
}

test("a row with no wake older than 5 min fails, notifies, and the next fire runs", async () => {
  const h = makeBoard();
  const s = await addSchedule(h, { kind: "interval", every: 1, unit: "hours" });
  await openRow(h, "young", s.id, T0 + HOUR - 4 * MIN);
  await openRow(h, "old", s.id, T0 + HOUR - 5 * MIN);
  h.clock.advance(HOUR);
  await h.board.tick();
  const rows = await runsOf(h, s.id);
  const old = rows.find((r) => r.id === "old");
  expect(old).toMatchObject({
    status: "failed",
    error: "The run did not start.",
    endedAt: T0 + HOUR,
  });
  // The young row is untouched and still open, so this fire is skipped.
  expect(rows.find((r) => r.id === "young")?.status).toBe("running");
  expect(h.runsMade).toHaveLength(0);
  expect(h.tells[0]?.text).toBe('Schedule "Brief" failed: The run did not start.');
  h.clock.advance(HOUR);
  await h.board.tick();
  expect((await runsOf(h, s.id)).find((r) => r.id === "young")?.status).toBe("failed");
  expect(h.runsMade).toHaveLength(1);
});

test("one rejected notice does not stop the pass, and a failed notice is sent again later", async () => {
  let calls = 0;
  const h = makeBoard({
    tell: async () => {
      calls += 1;
      if (calls === 1) throw new Error("post failed");
    },
  });
  const a = await addSchedule(h);
  const b = await addSchedule(h);
  await openRow(h, "ra", a.id, T0, "wa");
  await openRow(h, "rb", b.id, T0, "wb");
  putWake(h, "wa", "failed", { error: "boom" });
  putWake(h, "wb", "failed", { error: "boom" });
  await h.board.tick();
  expect((await runsOf(h, a.id))[0]?.status).toBe("failed");
  expect((await runsOf(h, b.id))[0]?.status).toBe("failed");
  expect(calls).toBe(2);
  // The first schedule's notice never went out today, so its next problem is told.
  await openRow(h, "ra2", a.id, T0 + 1, "wa2");
  putWake(h, "wa2", "failed", { error: "boom" });
  await h.board.tick();
  expect(calls).toBe(3);
});

test("the reconcile failure event names the bot", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  await openRow(h, "r", s.id, T0, "w");
  putWake(h, "w", "failed", { error: "boom" });
  await h.board.tick();
  expect(h.log.of("schedule.failed")[0]?.fields).toMatchObject({
    scheduleId: s.id,
    botId: "editor",
    reason: "failed",
  });
});
