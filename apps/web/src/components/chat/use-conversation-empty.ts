import { useQuery } from "@tanstack/react-query";
import { orpc } from "../../api/client";
import { type LiveRun, liveRunKey, type Receipt, receiptsKey } from "../../events/client-keys";
import { useConversationMessages } from "./use-conversation-messages";
import { useLocal } from "./use-local-cache";

/**
 * True when the conversation has nothing to show: no messages, no open or answered card and
 * no live run. A bot woken by a ticket can ask for approval before any message exists; the
 * transcript (the only place cards and runs render) must then show instead of the empty state.
 */
export function useConversationEmpty(conversationId: string, enabled: boolean): boolean {
  const messages = useConversationMessages(conversationId, enabled);
  const approvals = useQuery(orpc.approvals.pending.queryOptions()).data ?? [];
  const questions = useQuery(orpc.questions.pending.queryOptions()).data ?? [];
  const receipts = useLocal<Record<string, Receipt>>(receiptsKey(), {});
  const runs = useLocal<Record<string, LiveRun>>(liveRunKey(conversationId), {});
  const here = (c: { conversationId: string }) => c.conversationId === conversationId;
  return (
    messages.isSuccess &&
    messages.data.pages.every((p) => p.length === 0) &&
    !approvals.some(here) &&
    !questions.some(here) &&
    !Object.values(receipts).some((r) => here(r.card)) &&
    Object.keys(runs).length === 0
  );
}
