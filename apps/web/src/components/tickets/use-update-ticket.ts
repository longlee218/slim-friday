import type { TicketDto, TicketPriority, TicketStatus } from "@friday/contracts";
import {
  type InfiniteData,
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { patchTicket } from "./ticket-cache";
import { ticketListOptions } from "./use-tickets";

/** What the owner can change on a ticket (the contract's update input without the guard). */
export interface UpdateInput {
  ref: string;
  status?: TicketStatus;
  assignee?: string;
  priority?: TicketPriority;
  description?: string;
  blockedReason?: string;
}

/** The cached copy of a ticket: the detail query first, else the board list. */
function cachedTicket(qc: QueryClient, ref: string): TicketDto | undefined {
  const get = qc.getQueryData<{ ticket: TicketDto }>(orpc.tickets.get.queryKey({ input: { ref } }));
  if (get) return get.ticket;
  const list = qc.getQueryData<InfiniteData<{ items: TicketDto[] }>>(ticketListOptions.queryKey);
  return list?.pages.flatMap((p) => p.items).find((t) => t.ref === ref);
}

/** The ticket as it will look once `input` is saved (the board clears a blocked reason on leaving). */
function optimistic(t: TicketDto, input: UpdateInput): TicketDto {
  const status = input.status ?? t.status;
  return {
    ...t,
    status,
    priority: input.priority ?? t.priority,
    assigneeBotId: input.assignee ?? t.assigneeBotId,
    description: input.description ?? t.description,
    blockedReason: status === "blocked" ? (input.blockedReason ?? t.blockedReason) : undefined,
  };
}

/**
 * Owner edit of a ticket. The change shows at once; the call carries the cached `updatedAt` as
 * `expectedUpdatedAt`, so a write made elsewhere in between is refused (`CONFLICT`). Any failure
 * restores the snapshot; a conflict also says so and refetches the ticket.
 */
export function useUpdateTicket() {
  const qc = useQueryClient();
  return useMutation<TicketDto, Error, UpdateInput, { snapshot?: TicketDto }>({
    mutationFn: (input) => {
      const current = cachedTicket(qc, input.ref);
      if (!current) throw new Error("Ticket is not loaded.");
      return client.tickets.update({ ...input, expectedUpdatedAt: current.updatedAt });
    },
    onMutate: (input) => {
      const snapshot = cachedTicket(qc, input.ref);
      if (snapshot) patchTicket(qc, optimistic(snapshot, input));
      return { snapshot };
    },
    onError: (error, input, ctx) => {
      if (ctx?.snapshot) patchTicket(qc, ctx.snapshot);
      if ((error as { code?: string }).code === "CONFLICT") {
        toast("Changed elsewhere. Showing the latest.");
        void qc.invalidateQueries({
          queryKey: orpc.tickets.get.key({ input: { ref: input.ref } }),
        });
        void qc.invalidateQueries({ queryKey: orpc.tickets.list.key() });
      } else {
        toast("Could not save the ticket. Try again.");
      }
    },
    onSuccess: (ticket) => patchTicket(qc, ticket),
  });
}
