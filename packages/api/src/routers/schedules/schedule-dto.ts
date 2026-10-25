import type { ScheduleDto, ScheduleRunDto } from "@friday/contracts";
import { describeRule, type Schedule, type ScheduleRun, type Store } from "@friday/core";

/** The store parts the mappers read. */
type DtoStore = Pick<Store, "bots" | "scheduleRuns" | "messages">;

/** One fire as the web app sees it; `messageId` is the run's final chat message. */
export function toScheduleRunDto(r: ScheduleRun, messageId?: number): ScheduleRunDto {
  return {
    id: r.id,
    dueAt: r.dueAt,
    firedAt: r.firedAt,
    manual: r.manual,
    late: r.late,
    status: r.status,
    ...(r.endedAt !== undefined && { endedAt: r.endedAt }),
    costUsd: r.costUsd,
    ...(r.error !== undefined && { error: r.error }),
    ...(messageId !== undefined && { messageId }),
  };
}

/**
 * A schedule as the web app sees it. A schedule whose bot is gone shows as off (`bot_gone`) with no next
 * run: the engine switches it off only at its next fire, so the board must not promise that fire.
 */
export function toScheduleDto(s: Schedule, botExists: boolean, last?: ScheduleRun): ScheduleDto {
  const enabled = s.enabled && botExists;
  const disabledReason = botExists ? s.disabledReason : "bot_gone";
  return {
    id: s.id,
    name: s.name,
    botId: s.botId,
    task: s.task,
    rule: s.rule,
    timeZone: s.timeZone,
    when: describeRule(s.rule, s.timeZone),
    conversationId: s.conversationId,
    notify: s.notify,
    enabled,
    ...(enabled && s.nextRunAt !== undefined && { nextRunAt: s.nextRunAt }),
    ...(disabledReason && { disabledReason }),
    createdBy: s.createdBy,
    ...(last && { last: toScheduleRunDto(last) }),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** One schedule as a DTO, reading its bot and its latest run from the store. */
export async function scheduleDtoFor(store: DtoStore, s: Schedule): Promise<ScheduleDto> {
  const [bot, latest] = await Promise.all([
    store.bots.get(s.botId),
    store.scheduleRuns.latest([s.id]),
  ]);
  return toScheduleDto(s, bot !== undefined, latest.get(s.id));
}

/** Several schedules as DTOs (one bot list, one latest-run query): enabled first, then by next run. */
export async function scheduleDtosFor(store: DtoStore, ss: Schedule[]): Promise<ScheduleDto[]> {
  if (!ss.length) return [];
  const [bots, latest] = await Promise.all([
    store.bots.list(),
    store.scheduleRuns.latest(ss.map((s) => s.id)),
  ]);
  const botIds = new Set(bots.map((b) => b.id));
  const dtos = ss.map((s) => toScheduleDto(s, botIds.has(s.botId), latest.get(s.id)));
  const key = (d: ScheduleDto) => d.nextRunAt ?? Number.MAX_SAFE_INTEGER;
  return dtos.sort((a, b) => Number(b.enabled) - Number(a.enabled) || key(a) - key(b));
}

/** History rows as DTOs; only rows with a wake look up their final message. */
export function scheduleRunDtosFor(store: DtoStore, rs: ScheduleRun[]): Promise<ScheduleRunDto[]> {
  return Promise.all(
    rs.map(async (r) =>
      toScheduleRunDto(r, r.wakeId ? await store.messages.lastIdOf(r.wakeId) : undefined),
    ),
  );
}
