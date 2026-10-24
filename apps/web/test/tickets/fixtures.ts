import type { TicketDto } from "@friday/contracts";

/** A ticket with sensible defaults; `id` is also the number. */
export const ticket = (id: number, over: Partial<TicketDto> = {}): TicketDto => ({
  id: String(id),
  ref: `FRI-${id}`,
  number: id,
  title: `Ticket ${id}`,
  status: "todo",
  priority: "normal",
  createdBy: { kind: "user" },
  createdAt: 1,
  updatedAt: 10,
  commentCount: 0,
  ...over,
});
