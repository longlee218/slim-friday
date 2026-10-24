import type { BotId } from "../domain/bot";
import type { Author } from "../domain/message";
import type { Clock } from "../ports/clock";
import type { Store } from "../ports/store";
import {
  parseTicketRef,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Ticket,
  type TicketComment,
  type TicketPriority,
  type TicketStatus,
} from "./ticket";

/** Success with a payload, or a short reason a bot can read. */
export type TicketResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const STATUSES: readonly TicketStatus[] = TICKET_STATUSES;
const PRIORITIES: readonly TicketPriority[] = TICKET_PRIORITIES;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20_000;
const COMMENT_MAX = 10_000;
const PAGE_SIZE = 50;
/** Longest description in a list row (the full text comes with `get`). */
const LIST_DESCRIPTION_MAX = 200;

const INVALID = { ok: false, error: "Invalid ticket." } as const;
const UNKNOWN_BOT = { ok: false, error: "Unknown bot." } as const;
const BAD_STATUS = {
  ok: false,
  error: `status must be one of ${STATUSES.join(", ")}.`,
} as const;

/** A finished ticket is never woken. */
const finished = (s: TicketStatus) => s === "done" || s === "closed";

/** The shared board: the rules for creating, listing, changing and commenting on tickets. */
export class TicketBoard {
  constructor(
    private deps: {
      store: Pick<Store, "tickets" | "bots">;
      clock: Clock;
      /** Called when a ticket is assigned to a bot other than the one who did it. */
      wake: (ticket: Ticket, botId: BotId, actor: Author) => Promise<void>;
    },
  ) {}

  async create(
    actor: Author,
    i: { title: string; description?: string; priority?: TicketPriority; assigneeBotId?: BotId },
  ): Promise<TicketResult<{ ticket: Ticket }>> {
    const title = i.title.trim();
    if (!title || title.length > TITLE_MAX) return INVALID;
    if (i.description !== undefined && i.description.length > DESCRIPTION_MAX) return INVALID;
    if (i.priority !== undefined && !PRIORITIES.includes(i.priority)) return INVALID;
    const assigneeBotId = i.assigneeBotId ?? (actor.kind === "bot" ? actor.botId : undefined);
    if (assigneeBotId && !(await this.deps.store.bots.get(assigneeBotId))) return UNKNOWN_BOT;
    const ticket = await this.deps.store.tickets.create({
      title,
      ...(i.description && { description: i.description }),
      status: "todo",
      priority: i.priority ?? "normal",
      ...(assigneeBotId && { assigneeBotId }),
      createdBy: actor,
      createdAt: this.deps.clock.now(),
    });
    if (assigneeBotId && !(actor.kind === "bot" && actor.botId === assigneeBotId))
      await this.deps.wake(ticket, assigneeBotId, actor);
    return { ok: true, ticket };
  }

  async get(ref: string): Promise<TicketResult<{ ticket: Ticket; comments: TicketComment[] }>> {
    const ticket = await this.find(ref);
    if (!ticket) return { ok: false, error: `Ticket ${ref} not found.` };
    return { ok: true, ticket, comments: await this.deps.store.tickets.comments(ticket.id) };
  }

  async list(i: {
    status?: TicketStatus;
    assigneeBotId?: BotId;
    cursor?: string;
  }): Promise<TicketResult<{ tickets: Ticket[]; nextCursor?: string }>> {
    if (i.status !== undefined && !STATUSES.includes(i.status)) return BAD_STATUS;
    let before: { createdAt: number; id: string } | undefined;
    if (i.cursor !== undefined) {
      before = decodeCursor(i.cursor);
      if (!before) return { ok: false, error: "cursor is invalid." };
    }
    // One extra row tells whether another page follows.
    const rows = await this.deps.store.tickets.list({
      ...(i.status ? { status: i.status } : { excludeClosed: true }),
      ...(i.assigneeBotId && { assigneeBotId: i.assigneeBotId }),
      ...(before && { before }),
      limit: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE).map(shortDescription);
    const last = page[page.length - 1];
    return {
      ok: true,
      tickets: page,
      ...(rows.length > PAGE_SIZE && last && { nextCursor: encodeCursor(last) }),
    };
  }

  async update(
    actor: Author,
    i: {
      id: string;
      title?: string;
      description?: string | null;
      priority?: TicketPriority;
      status?: TicketStatus;
      assigneeBotId?: BotId;
    },
  ): Promise<TicketResult<{ ticket: Ticket }>> {
    const cur = await this.find(i.id);
    if (!cur) return { ok: false, error: "Ticket not found." };
    if (i.status !== undefined && !STATUSES.includes(i.status)) return BAD_STATUS;
    const title = i.title?.trim();
    if (title !== undefined && (!title || title.length > TITLE_MAX)) return INVALID;
    if (i.description && i.description.length > DESCRIPTION_MAX) return INVALID;
    if (i.priority !== undefined && !PRIORITIES.includes(i.priority)) return INVALID;
    if (i.assigneeBotId && !(await this.deps.store.bots.get(i.assigneeBotId))) return UNKNOWN_BOT;
    const ticket = await this.deps.store.tickets.update(
      cur.id,
      {
        ...(title !== undefined && { title }),
        ...(i.description !== undefined && { description: i.description ?? undefined }),
        ...(i.priority && { priority: i.priority }),
        ...(i.status && { status: i.status }),
        ...(i.assigneeBotId && { assigneeBotId: i.assigneeBotId }),
      },
      this.deps.clock.now(),
    );
    if (!ticket) return { ok: false, error: "Ticket not found." };
    const changed = i.assigneeBotId && i.assigneeBotId !== cur.assigneeBotId;
    const byActor = actor.kind === "bot" && actor.botId === i.assigneeBotId;
    if (changed && i.assigneeBotId && !byActor && !finished(ticket.status))
      await this.deps.wake(ticket, i.assigneeBotId, actor);
    return { ok: true, ticket };
  }

  async comment(
    actor: Author,
    i: { id: string; body: string },
  ): Promise<TicketResult<{ comment: TicketComment }>> {
    const body = i.body.trim();
    if (!body || body.length > COMMENT_MAX) return INVALID;
    const ticket = await this.find(i.id);
    if (!ticket) return { ok: false, error: "Ticket not found." };
    const comment = await this.deps.store.tickets.addComment({
      ticketId: ticket.id,
      author: actor,
      body,
      createdAt: this.deps.clock.now(),
    });
    return { ok: true, comment };
  }

  /** A ticket by ref (`fri-3`, any case) or by id. A ref of another prefix is not a ticket. */
  private async find(refOrId: string): Promise<Ticket | undefined> {
    const n = parseTicketRef(refOrId);
    if (n !== undefined) return this.deps.store.tickets.getByNumber(n);
    if (/^[A-Za-z]+-\d+$/.test(refOrId.trim())) return undefined;
    return this.deps.store.tickets.get(refOrId.trim());
  }
}

/** Description cut for a list row. */
function shortDescription(t: Ticket): Ticket {
  if (!t.description || t.description.length <= LIST_DESCRIPTION_MAX) return t;
  return { ...t, description: `${t.description.slice(0, LIST_DESCRIPTION_MAX)}…` };
}

/** Position after a ticket; `createdAt` and `id` never change, so an edited or deleted ticket cannot break paging. */
const encodeCursor = (t: Ticket): string =>
  Buffer.from(`${t.createdAt}|${t.id}`).toString("base64url");

function decodeCursor(c: string): { createdAt: number; id: string } | undefined {
  const [at, ...rest] = Buffer.from(c, "base64url").toString().split("|");
  const createdAt = Number(at);
  const id = rest.join("|");
  return Number.isFinite(createdAt) && at !== "" && id ? { createdAt, id } : undefined;
}
