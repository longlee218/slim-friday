import { createTanstackQueryUtils } from "@orpc/tanstack-query";

/**
 * A stand-in for `api/client`: the given ticket procedures plus empty bot, group and
 * conversation lists, wrapped in the real query-utils builder so keys and options match the app.
 */
export function mockApi(tickets: Record<string, unknown>) {
  const empty = async () => [];
  const client = {
    tickets: {
      list: async () => ({ items: [] }),
      get: async () => ({}),
      comment: async () => ({}),
      ...tickets,
    },
    config: { bots: { list: empty }, groups: { list: empty } },
    conversations: { list: empty },
    control: { status: empty, toolCheck: empty },
    approvals: { pending: empty },
    questions: { pending: empty },
  };
  return { client, orpc: createTanstackQueryUtils(client as never) };
}
