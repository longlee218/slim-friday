import type { ScheduleDto, ScheduleRunDto } from "@friday/contracts";
import {
  type Conversation,
  describeRule,
  type Schedule,
  type ScheduleRun,
  type Store,
} from "@friday/core";

/** The store parts the mappers read. */
type DtoStore = Pick<Store, "bots" | "groups" | "conversations" | "scheduleRuns" | "messages">;

/** Whether a schedule's bot and its chat (with the chat's group) still exist. */
export interface TargetState {
  botExists: boolean;
  chatExists: boolean;
}

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
 * The off reason as the target stands now: a missing bot or chat wins (the engine marks it only at the
 * next fire); a stored `bot_gone`/`group_gone` whose target is back is plain off, so the owner can
 * turn it on again.
 */
function reasonOf(s: Schedule, t: TargetState): Schedule["disabledReason"] {
  if (!t.botExists) return "bot_gone";
  if (!t.chatExists) return "group_gone";
  return s.disabledReason === "bot_gone" || s.disabledReason === "group_gone"
    ? undefined
    : s.disabledReason;
}

/**
 * A schedule as the web app sees it. A schedule whose bot or chat is gone shows as off with no next
 * run: the engine switches it off only at its next fire, so the board must not promise that fire.
 */
export function toScheduleDto(s: Schedule, t: TargetState, last?: ScheduleRun): ScheduleDto {
  const enabled = s.enabled && t.botExists && t.chatExists;
  const disabledReason = reasonOf(s, t);
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

/** Ids of the chats in `convs` that still stand: direct chats, and group chats whose group exists. */
async function liveChats(store: DtoStore, convs: Conversation[]): Promise<Set<string>> {
  const groupIds = [...new Set(convs.flatMap((c) => (c.kind === "group" ? [c.groupId] : [])))];
  const groups = await Promise.all(groupIds.map((g) => store.groups.get(g)));
  const liveGroups = new Set(groupIds.filter((_, i) => groups[i] !== undefined));
  return new Set(
    convs.filter((c) => c.kind === "direct" || liveGroups.has(c.groupId)).map((c) => c.id),
  );
}

/** One schedule as a DTO, reading its bot, its chat and its latest run from the store. */
export async function scheduleDtoFor(store: DtoStore, s: Schedule): Promise<ScheduleDto> {
  const [bot, conv, latest] = await Promise.all([
    store.bots.get(s.botId),
    store.conversations.get(s.conversationId),
    store.scheduleRuns.latest([s.id]),
  ]);
  const chatExists = conv !== undefined && (await liveChats(store, [conv])).has(conv.id);
  return toScheduleDto(s, { botExists: bot !== undefined, chatExists }, latest.get(s.id));
}

/**
 * Several schedules as DTOs (one bot list, one chat list, one get per group in use, one latest-run
 * query): enabled first, then by next run.
 */
export async function scheduleDtosFor(store: DtoStore, ss: Schedule[]): Promise<ScheduleDto[]> {
  if (!ss.length) return [];
  const used = new Set(ss.map((s) => s.conversationId));
  const [bots, convs, latest] = await Promise.all([
    store.bots.list(),
    store.conversations.list(),
    store.scheduleRuns.latest(ss.map((s) => s.id)),
  ]);
  const botIds = new Set(bots.map((b) => b.id));
  const chats = await liveChats(
    store,
    convs.filter((c) => used.has(c.id)),
  );
  const target = (s: Schedule) => ({
    botExists: botIds.has(s.botId),
    chatExists: chats.has(s.conversationId),
  });
  const dtos = ss.map((s) => toScheduleDto(s, target(s), latest.get(s.id)));
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
