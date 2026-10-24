import type { BotStatusDto } from "@friday/contracts";
import type { ApiDeps } from "../app";

/** UTC day key (`YYYY-MM-DD`) the spend table uses. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One entry per bot with an open session: `working` when any of its sessions is busy, every
 * background task, the first task as `label`, today's spend and the oldest session's start.
 */
export async function botStatusDtos(
  deps: Pick<ApiDeps, "hub" | "store" | "now">,
): Promise<BotStatusDto[]> {
  const byBot = new Map<string, ReturnType<ApiDeps["hub"]["status"]>>();
  for (const s of deps.hub.status()) byBot.set(s.botId, [...(byBot.get(s.botId) ?? []), s]);
  const day = utcDay(deps.now());
  return Promise.all(
    [...byBot].map(async ([botId, sessions]) => {
      const tasks = sessions.flatMap((s) =>
        s.tasks.map((t) => ({ id: t.taskId, description: t.description })),
      );
      const bot = await deps.store.bots.get(botId);
      return {
        botId,
        name: bot?.name ?? botId,
        working: sessions.some((s) => s.busy),
        ...(tasks[0] && { label: tasks[0].description }),
        tasks,
        spendToday: await deps.store.spend.total(botId, day),
        startedAt: Math.min(...sessions.map((s) => s.openedAt)),
      };
    }),
  );
}
