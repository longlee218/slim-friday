import type { Author } from "../domain/message";
import { errText } from "../hub/hub-types";
import type { Schedule, ScheduleRun } from "./schedule";
import { fieldError, noNextRun, targetError } from "./schedule-board-checks";
import {
  changed,
  inScope,
  invalid,
  type NewSchedule,
  NOT_FOUND,
  type ScheduleBoardDeps,
  type SchedulePatch,
  type ScheduleResult,
  type ScheduleScope,
} from "./schedule-board-types";
import { type FireCtx, fireDue, hasOpenRun, startRun } from "./schedule-fire";
import { ScheduleNotices } from "./schedule-notices";
import { reconcileRuns } from "./schedule-reconcile";
import { timeZoneError } from "./schedule-rules";

export type {
  NewSchedule,
  ScheduleBoardDeps,
  SchedulePatch,
  ScheduleResult,
  ScheduleScope,
} from "./schedule-board-types";

/** Refusal of a hub built without next-occurrence math. */
const UNAVAILABLE = invalid("Schedules are not available.");

/** The schedules: the rules for creating and changing them, and the ticker pass that fires and settles them. */
export class ScheduleBoard {
  private notices: ScheduleNotices;

  constructor(private deps: ScheduleBoardDeps) {
    this.notices = new ScheduleNotices(deps);
  }

  /** Validate and store a new schedule with its first next run; the zone defaults to the owner's. */
  async create(input: NewSchedule, by: Author): Promise<ScheduleResult<{ schedule: Schedule }>> {
    const { nextRunAt } = this.deps;
    if (!nextRunAt) return UNAVAILABLE;
    const timeZone = input.timeZone ?? this.deps.timeZone();
    const why =
      fieldError(input) ?? timeZoneError(timeZone) ?? (await targetError(this.deps.store, input));
    if (why) return invalid(why);
    const now = this.deps.clock.now();
    const next = nextRunAt(input.rule, timeZone, now);
    if (next === undefined) return invalid(noNextRun(input.rule));
    const schedule: Schedule = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      botId: input.botId,
      task: input.task.trim(),
      rule: input.rule,
      timeZone,
      conversationId: input.conversationId,
      notify: input.notify ?? "always",
      enabled: true,
      nextRunAt: next,
      createdBy: by,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.schedules.insert(schedule);
    changed(this.deps, schedule.id);
    return { ok: true, schedule };
  }

  /**
   * A new rule, or `enabled: true` on a disabled schedule, recomputes the next run from now (turning on also needs the
   * bot and chat to exist); `enabled: false` clears it.
   */
  async update(
    id: string,
    patch: SchedulePatch,
    scope?: ScheduleScope,
  ): Promise<ScheduleResult<{ schedule: Schedule }>> {
    const cur = await this.get(id, scope);
    if (!cur) return NOT_FOUND;
    const why = fieldError(patch);
    if (why) return invalid(why);
    const now = this.deps.clock.now();
    const rule = patch.rule ?? cur.rule;
    const enabled = patch.enabled ?? cur.enabled;
    const { name, task, notify } = patch;
    const next: Partial<Schedule> = {
      ...(name !== undefined && { name: name.trim() }),
      ...(task !== undefined && { task: task.trim() }),
      ...(notify !== undefined && { notify }),
      ...(patch.rule && { rule }),
      ...(patch.enabled !== undefined && { enabled }),
      updatedAt: now,
    };
    // Turning on a disabled schedule needs its bot and chat back; an enabled one keeps its phase.
    const turningOn = patch.enabled === true && !cur.enabled;
    const gone = turningOn ? await targetError(this.deps.store, cur) : undefined;
    if (gone) return invalid(gone);
    if (patch.rule || turningOn) {
      if (!this.deps.nextRunAt) return UNAVAILABLE;
      const at = this.deps.nextRunAt(rule, cur.timeZone, now);
      if (at === undefined) return invalid(noNextRun(rule));
      if (enabled) next.nextRunAt = at;
    }
    // An explicit undefined clears the stored value.
    if (turningOn) next.disabledReason = undefined;
    if (patch.enabled === false) next.nextRunAt = undefined;
    const schedule = await this.deps.store.schedules.update(id, next);
    if (!schedule) return NOT_FOUND;
    changed(this.deps, id);
    return { ok: true, schedule };
  }

  /** Delete a schedule (and its history) inside the scope. */
  async remove(id: string, scope?: ScheduleScope): Promise<ScheduleResult<object>> {
    if (!(await this.get(id, scope))) return NOT_FOUND;
    if (!(await this.deps.store.schedules.remove(id))) return NOT_FOUND;
    changed(this.deps, id);
    return { ok: true };
  }

  /** Schedules inside the scope, by creation time. */
  list(scope?: ScheduleScope): Promise<Schedule[]> {
    return this.deps.store.schedules.list(scope);
  }

  /** One schedule, or undefined when missing or outside the scope. */
  async get(id: string, scope?: ScheduleScope): Promise<Schedule | undefined> {
    const s = await this.deps.store.schedules.get(id);
    return s && inScope(s, scope) ? s : undefined;
  }

  /** History rows of a schedule, newest first. */
  runs(id: string, limit: number, before?: number): Promise<ScheduleRun[]> {
    return this.deps.store.scheduleRuns.list(id, limit, before);
  }

  /**
   * Fire at once outside the schedule; refused while its last run is open. Does not move the next run.
   * Not serialized with `tick`: a tick firing the same schedule at the same moment can add a second run.
   */
  async runNow(id: string, nonce: string): Promise<ScheduleResult<{ wakeId: string }>> {
    const s = await this.get(id);
    if (!s) return NOT_FOUND;
    const f = this.fireCtx();
    if (!f) return UNAVAILABLE;
    if (await hasOpenRun(this.deps, id))
      return { ok: false, code: "conflict", error: "Still running." };
    const now = this.deps.clock.now();
    const out = await startRun(f, s, now, now, true, `sched:${id}:manual:${nonce}`);
    return "wakeId" in out ? { ok: true, wakeId: out.wakeId } : invalid(out.error);
  }

  /**
   * One ticker pass: settle open history rows, then fire every due schedule. Never throws.
   * Not re-entrant: the caller (the ticker) must never run two passes at once.
   */
  async tick(): Promise<void> {
    try {
      await reconcileRuns(this.deps, this.notices);
    } catch (err) {
      this.deps.log?.error({ error: errText(err) }, "schedule.reconcile_failed");
    }
    const f = this.fireCtx();
    if (!f) return;
    let due: Schedule[] = [];
    try {
      due = await this.deps.store.schedules.due(this.deps.clock.now());
    } catch (err) {
      this.deps.log?.error({ error: errText(err) }, "schedule.due_failed");
    }
    for (const s of due) {
      try {
        await fireDue(f, s, this.deps.clock.now());
      } catch (err) {
        this.deps.log?.error({ error: errText(err), scheduleId: s.id }, "schedule.fire_failed");
      }
    }
  }

  /** What the fire steps need; undefined without next-occurrence math. */
  private fireCtx(): FireCtx | undefined {
    const { nextRunAt } = this.deps;
    return nextRunAt && { deps: this.deps, nextRunAt, notices: this.notices };
  }
}
