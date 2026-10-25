import type { NextRunAt, RepeatRule, Schedule, ScheduleRun, WakeRow } from "../../src";
import type { WakeOutcome } from "../../src/hub/hub-types";
import type { NewRun } from "../../src/runs/run-create";
import { ScheduleBoard, type ScheduleBoardDeps } from "../../src/schedules/schedule-board";
import { bot } from "../bot-hub-harness";
import { FakeClock } from "../fakes/fake-clock";
import { FakeLog } from "../fakes/fake-log";
import { FakeStore } from "../fakes/fake-store";
import { FakeSurface } from "../fakes/fake-surface";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** Start time of every test: Sun 25 Oct 2026 00:00 UTC. */
export const T0 = Date.parse("2026-10-25T00:00:00Z");

/** A small UTC-only `NextRunAt` for tests (daily, interval, once). */
export const fakeNextRunAt: NextRunAt = (rule, _tz, after, anchor) => {
  if (rule.kind === "once") {
    const at = Date.parse(`${rule.date}T${rule.at}:00Z`);
    // Date.parse rolls 31 Feb over to March: such a day does not exist.
    const real = !Number.isNaN(at) && new Date(at).toISOString().startsWith(rule.date);
    return !real || at <= after ? undefined : at;
  }
  if (rule.kind === "interval") {
    const gap = rule.every * (rule.unit === "minutes" ? MIN : HOUR);
    if (anchor === undefined) return after + gap;
    return anchor + (Math.floor((after - anchor) / gap) + 1) * gap;
  }
  const [h, m] = rule.at.split(":").map(Number);
  const offset = (h ?? 0) * HOUR + (m ?? 0) * MIN;
  let at = Math.floor(after / DAY) * DAY + offset;
  while (at <= after) at += DAY;
  return at;
};

/**
 * A board over fakes: bots writer and editor in group "g" (chat "gc"), direct chats "dc" (editor) and "dw"
 * (writer), a bot "loner" in no group. `createRun` answers from `outcomes` (then ok with `w<n>`).
 */
export function makeBoard(over: Partial<ScheduleBoardDeps> = {}) {
  const store = new FakeStore();
  for (const id of ["writer", "editor", "loner"]) store.botMap.set(id, bot(id, id));
  store.groupMap.set("g", {
    id: "g",
    name: "G",
    members: ["writer", "editor"],
    entryBot: "writer",
    workspaces: [],
    instructions: "",
  });
  store.convMap.set("gc", { id: "gc", kind: "group", groupId: "g" });
  store.convMap.set("dc", { id: "dc", kind: "direct", botId: "editor" });
  store.convMap.set("dw", { id: "dw", kind: "direct", botId: "writer" });
  const clock = new FakeClock(T0);
  const surface = new FakeSurface();
  const log = new FakeLog();
  const runsMade: NewRun[] = [];
  const outcomes: WakeOutcome[] = [];
  const tells: { conversationId: string; text: string }[] = [];
  const changes: string[] = [];
  const board = new ScheduleBoard({
    store,
    clock,
    nextRunAt: fakeNextRunAt,
    timeZone: () => "UTC",
    createRun: async (r) => {
      runsMade.push(r);
      return outcomes.shift() ?? { ok: true, wakeId: `w${runsMade.length}` };
    },
    tell: async (conversationId, text) => {
      tells.push({ conversationId, text });
    },
    notifyFinished: (e) => surface.notifyFinished(e),
    log,
    onChange: (id) => changes.push(id),
    ...over,
  });
  return { board, store, clock, surface, log, runsMade, outcomes, tells, changes };
}

/** Create a schedule for editor in "dc" and return it (throws when refused). */
export async function addSchedule(
  h: ReturnType<typeof makeBoard>,
  rule: RepeatRule = { kind: "daily", at: "07:30" },
  over: { notify?: Schedule["notify"]; conversationId?: string; botId?: string } = {},
): Promise<Schedule> {
  const r = await h.board.create(
    {
      name: "Brief",
      botId: over.botId ?? "editor",
      task: "Write the brief.",
      rule,
      conversationId: over.conversationId ?? "dc",
      ...(over.notify && { notify: over.notify }),
    },
    { kind: "user" },
  );
  if (!r.ok) throw new Error(r.error);
  return r.schedule;
}

/** History rows of a schedule, oldest first. */
export async function runsOf(h: ReturnType<typeof makeBoard>, id: string): Promise<ScheduleRun[]> {
  return (await h.store.scheduleRuns.list(id, 100)).reverse();
}

/** Store a wake row with the given id and status (plus any other fields). */
export function putWake(
  h: ReturnType<typeof makeBoard>,
  id: string,
  status: WakeRow["status"],
  over: Partial<WakeRow> = {},
): void {
  h.store.wakeMap.set(id, {
    id,
    chainId: id,
    conversationId: "dc",
    targetBot: "editor",
    sender: { kind: "system" },
    intent: "request",
    hop: 0,
    text: "",
    status,
    attempts: 1,
    createdAt: T0,
    scopeKey: "editor",
    priority: "background",
    leaseFence: 0,
    cuts: 0,
    transientRetries: 0,
    setupFailures: 0,
    nudges: 0,
    ...over,
  });
}
