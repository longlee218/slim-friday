import type { MessageDto } from "@friday/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { client } from "../../api/client";
import { appendMessage } from "../../events/apply-messages";
import { endRun, startRun } from "../../events/apply-runs";
import {
  type PendingSend,
  pendingKey,
  type SendPayload,
  setPending,
  swapTemp,
  sweepPending,
} from "./pending-sends";
import type { RouteInfo } from "./route-info";

/** Next temp id; negative so it never meets a server id. */
let nextTemp = -1;

/** What the composer hands over for one send. */
export interface SendInput {
  payload: SendPayload;
  route: RouteInfo;
  /** Quoted bot message for the optimistic bubble. */
  quote?: { botId: string; excerpt: string };
}

/**
 * Optimistic send. The owner message shows at once under a negative temp id; the reply swaps
 * it for the real id. A failure keeps it as "Not sent" with Retry (same payload and uploads).
 * Each routed bot gets a client live run while the engine works.
 */
export function useSendMessage() {
  const qc = useQueryClient();
  return useMemo(() => {
    /** Calls the API for a temp message and settles its pending state. */
    async function deliver(tempId: number, p: PendingSend): Promise<void> {
      setPending(qc, tempId, { ...p, state: "sending" });
      for (const id of p.route.botIds) startRun(qc, p.payload.conversationId, id, Date.now());
      try {
        const { messageId } = await client.chat.send(p.payload);
        swapTemp(qc, p.payload.conversationId, tempId, messageId);
        setPending(qc, tempId, null);
      } catch {
        // Any failure, CONFLICT included, is "Not sent"; a retry reuses the nonce and the engine replays.
        for (const id of p.route.botIds) endRun(qc, p.payload.conversationId, id);
        setPending(qc, tempId, { ...p, state: "failed" });
      }
      // A settled send is a good moment to forget entries whose temp message is gone.
      sweepPending(qc);
    }

    return {
      /** Shows the message and sends it; resolves when the call settled. */
      send(input: SendInput): Promise<void> {
        const tempId = nextTemp--;
        // One nonce per message; `retry` resends this payload, so the engine stores the message once.
        const payload: SendPayload = { ...input.payload, clientNonce: crypto.randomUUID() };
        const message: MessageDto = {
          id: tempId,
          conversationId: payload.conversationId,
          author: { kind: "user" },
          kind: "text",
          text: payload.text,
          at: Date.now(),
          files: [],
          ...(payload.replyTo !== undefined && {
            replyTo: {
              messageId: payload.replyTo,
              excerpt: input.quote?.excerpt ?? "",
              ...(input.quote && { botId: input.quote.botId }),
            },
          }),
        };
        appendMessage(qc, message);
        return deliver(tempId, { state: "sending", payload, route: input.route });
      },
      /** Resends a failed message with the same payload. */
      retry(tempId: number): Promise<void> {
        const p = qc.getQueryData<Record<number, PendingSend>>(pendingKey)?.[tempId];
        // Only a failed entry retries; a second click while sending does nothing.
        return p?.state === "failed" ? deliver(tempId, p) : Promise.resolve();
      },
    };
  }, [qc]);
}
