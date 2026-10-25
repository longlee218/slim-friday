import type { Author } from "../domain/message";
import { errText } from "../hub/hub-types";
import type { Schedule, ScheduleRun } from "./schedule";
import {
  changed,
  inScope,
  invalid,
  NAME_MAX,
  type NewSchedule,
  NOT_FOUND,
  NOTIFY_MODES,
  type ScheduleBoardDeps,
  type SchedulePatch,
  type ScheduleResult,
  type ScheduleScope,
  TASK_MAX,
} from "./schedule-board-types";
import { type FireCtx, fireDue, hasOpenRun, startRun } from "./schedule-fire";
import { ScheduleNotices } from "./schedule-notices";
import { reconcileRuns } from "./schedule-reconcile";
import { ruleError, timeZoneError } from "./schedule-rules";

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

  async create(input: NewSchedule, by: Author): Promise<ScheduleResult<{ schedule: Schedule }>> {
    const { nextRunAt } = this.deps;
    if (!nextRunAt) return UNAVAILABLE;
    const timeZone = input.timeZone ?? this.deps.timeZone();
    const why = fieldError(input) ?? timeZoneError(timeZone) ?? (await this.targetError(input));
    if (why) return invalid(why);
    const now = this.deps.clock.now();
    const next = nextRunAt(input.rule, timeZone, now);
    if (next === undefined) return invalid(noNextRun(input.rule.kind));
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

  /** A new rule or `enabled: true` recomputes the next run from now; `enabled: false` clears it. */
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
    if (patch.rule || patch.enabled === true) {
      if (!this.deps.nextRunAt) return UNAVAILABLE;
      const at = this.deps.nextRunAt(rule, cur.timeZone, now);
      if (at === undefined) return invalid(noNextRun(rule.kind));
      if (enabled) next.nextRunAt = at;
    }
    // An explicit undefined clears the stored value.
    if (patch.enabled === true) next.disabledReason = undefined;
    if (patch.enabled === false) next.nextRunAt = undefined;
    const schedule = await this.deps.store.schedules.update(id, next);
    if (!schedule) return NOT_FOUND;
    changed(this.deps, id);
    return { ok: true, schedule };
  }

  async remove(id: string, scope?: ScheduleScope): Promise<ScheduleResult<object>> {
    if (!(await this.get(id, scope))) return NOT_FOUND;
    if (!(await this.deps.store.schedules.remove(id))) return NOT_FOUND;
    changed(this.deps, id);
    return { ok: true };
  }

  list(scope?: ScheduleScope): Promise<Schedule[]> {
    return this.deps.store.schedules.list(scope);
  }

  async get(id: string, scope?: ScheduleScope): Promise<Schedule | undefined> {
    const s = await this.deps.store.schedules.get(id);
    return s && inScope(s, scope) ? s : undefined;
  }

  /** History rows of a schedule, newest first. */
  runs(id: string, limit: number, before?: number): Promise<ScheduleRun[]> {
    return this.deps.store.scheduleRuns.list(id, limit, before);
  }

  /** Fire at once outside the schedule; refused while its last run is open. Does not move the next run. */
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

  /** One ticker pass: settle open history rows, then fire every due schedule. Never throws. */
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

  /** Why the bot or conversation cannot take the schedule: the bot must exist and own or belong to the chat. */
  private async targetError(i: NewSchedule): Promise<string | undefined> {
    const { store } = this.deps;
    if (!(await store.bots.get(i.botId))) return `unknown bot "${i.botId}"`;
    const conv = await store.conversations.get(i.conversationId);
    if (!conv) return `unknown conversation "${i.conversationId}"`;
    if (conv.kind === "direct")
      return conv.botId === i.botId ? undefined : "a direct chat must be the bot's own";
    const group = await store.groups.get(conv.groupId);
    return group?.members.includes(i.botId) ? undefined : "the bot is not a member of that group";
  }
}

/** Why the name, task, rule or notify of a create or patch is invalid (only the fields present are checked). */
function fieldError(p: SchedulePatch): string | undefined {
  const name = p.name?.trim();
  if (p.name !== undefined && (!name || name.length > NAME_MAX))
    return `name must be 1 to ${NAME_MAX} characters`;
  const task = p.task?.trim();
  if (p.task !== undefined && (!task || task.length > TASK_MAX))
    return `task must be 1 to ${TASK_MAX} characters`;
  if (p.notify !== undefined && !NOTIFY_MODES.includes(p.notify))
    return 'notify must be "always" or "problems"';
  return p.rule && ruleError(p.rule);
}

/** The refusal text of a rule with no next run. */
const noNextRun = (kind: Schedule["rule"]["kind"]) =>
  kind === "once" ? "That time is already past." : "That rule never fires.";
