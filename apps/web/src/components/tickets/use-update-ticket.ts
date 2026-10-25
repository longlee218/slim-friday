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

/** The cached detail copy of a ticket (`tickets.get`), with its full description. */
const cachedGet = (qc: QueryClient, ref: string): TicketDto | undefined =>
  qc.getQueryData<{ ticket: TicketDto }>(orpc.tickets.get.queryKey({ input: { ref } }))?.ticket;

/** The cached copy of a ticket: the detail query first, else the board list. */
function cachedTicket(qc: QueryClient, ref: string): TicketDto | undefined {
  const get = cachedGet(qc, ref);
  if (get) return get;
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

/** `updatedAt` each call saw before its optimistic patch (a close removes the ticket from the cache). */
const basedOn = new WeakMap<UpdateInput, number>();

/**
 * Owner edit of ticket `ref`. The change shows at once; the call carries the ticket's `updatedAt`
 * as `expectedUpdatedAt`, so a write made elsewhere in between is refused (`CONFLICT`). Edits of
 * one ticket run one after another (mutation scope), and each reads the version the previous
 * one saved, so two quick edits do not conflict with each other. Any failure restores the
 * snapshot; a conflict also says so and refetches the ticket.
 */
export function useUpdateTicket(ref: string) {
  const qc = useQueryClient();
  return useMutation<TicketDto, Error, UpdateInput, { snapshot?: TicketDto; fromList: boolean }>({
    scope: { id: `ticket:${ref}` },
    mutationFn: (input) => {
      // Newest known version: the cache after the previous edit saved, else what this call saw.
      const expected = Math.max(
        cachedTicket(qc, input.ref)?.updatedAt ?? 0,
        basedOn.get(input) ?? 0,
      );
      if (expected === 0) throw new Error("Ticket is not loaded.");
      return client.tickets.update({ ...input, expectedUpdatedAt: expected });
    },
    onMutate: (input) => {
      // Read before patching: a close drops the ticket from the list.
      const fromList = cachedGet(qc, input.ref) === undefined;
      const snapshot = cachedTicket(qc, input.ref);
      if (snapshot) {
        basedOn.set(input, snapshot.updatedAt);
        patchTicket(qc, optimistic(snapshot, input));
      }
      return { snapshot, fromList };
    },
    onError: (error, input, ctx) => {
      if (ctx?.snapshot) {
        // A list snapshot holds a shortened description: keep the full one a get loaded meanwhile.
        const full = ctx.fromList ? cachedGet(qc, input.ref)?.description : undefined;
        patchTicket(qc, full === undefined ? ctx.snapshot : { ...ctx.snapshot, description: full });
      }
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
