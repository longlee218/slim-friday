import { createTanstackQueryUtils } from "@orpc/tanstack-query";

/**
 * A stand-in for `api/client`: the given schedule procedures plus empty bot, group and
 * conversation lists, wrapped in the real query-utils builder so keys and options match the app.
 */
export function mockApi(schedules: Record<string, unknown>) {
  const empty = async () => [];
  const client = {
    schedules: { list: async () => ({ items: [] }), ...schedules },
    config: { bots: { list: empty }, groups: { list: empty } },
    conversations: { list: empty },
    // `seededClient` builds these keys too.
    tickets: { list: async () => ({ items: [] }) },
    control: { status: empty, toolCheck: empty },
    approvals: { pending: empty },
    questions: { pending: empty },
  };
  return { client, orpc: createTanstackQueryUtils(client as never) };
}
