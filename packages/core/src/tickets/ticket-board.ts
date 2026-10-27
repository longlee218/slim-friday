import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { GroupId } from "../domain/group";
import type { Author } from "../domain/message";
import type { Clock } from "../ports/clock";
import type { Store } from "../ports/store";
import type { Ticket, TicketComment, TicketPriority, TicketStatus } from "./ticket";
import { assigneeRefusal } from "./ticket-assignee";
import {
  BAD_STATUS,
  BLOCKED_REASON_MAX,
  COMMENT_MAX,
  CONFLICT,
  cleanText,
  DESCRIPTION_MAX,
  finished,
  INVALID,
  NOT_FOUND,
  PRIORITIES,
  REASON_REQUIRED,
  STATUSES,
  TITLE_MAX,
  type TicketResult,
  type TicketUpdateInput,
} from "./ticket-board-rules";
import { createdEvent, ticketChangeEvents } from "./ticket-change-events";
import { type TicketDetail, TicketReads } from "./ticket-reads";

export type { TicketErrorCode, TicketResult } from "./ticket-board-rules";

/** The shared board: the rules for creating, listing, changing and commenting on tickets. */
export class TicketBoard {
  /** Reads (one ticket, its timeline, list pages) live in their own class. */
  private reads: TicketReads;

  constructor(
    private deps: {
      store: Pick<Store, "tickets" | "bots" | "groups" | "ticketEvents">;
      clock: Clock;
      /** Called when a ticket is assigned to a bot other than the one who did it. */
      wake: (ticket: Ticket, botId: BotId, actor: Author) => Promise<void>;
      /** Told after every saved create, update and comment; whatever it throws stays here. */
      onChange?: (t: Ticket) => void;
      /** The configured secret values to hide in ticket text (the app's denied env values). */
      secretValues?: () => string[];
    },
  ) {
    this.reads = new TicketReads(deps.store);
  }

  async create(
    actor: Author,
    i: {
      title: string;
      description?: string;
      priority?: TicketPriority;
      assigneeBotId?: BotId;
      conversationId?: ConversationId;
      /** The group of the creating session; the ticket is then assigned to its members only. */
      groupId?: GroupId;
    },
  ): Promise<TicketResult<{ ticket: Ticket }>> {
    const title = cleanText(this.deps.secretValues, i.title.trim());
    if (!title || title.length > TITLE_MAX) return INVALID;
    if (i.description !== undefined && i.description.length > DESCRIPTION_MAX) return INVALID;
    if (i.priority !== undefined && !PRIORITIES.includes(i.priority)) return INVALID;
    const assigneeBotId = i.assigneeBotId ?? (actor.kind === "bot" ? actor.botId : undefined);
    const refused = await assigneeRefusal(this.deps.store, assigneeBotId, i.groupId);
    if (refused) return refused;
    // The created event is written in the same transaction as the ticket.
    const ticket = await this.deps.store.tickets.create(
      {
        title,
        ...(i.description && { description: cleanText(this.deps.secretValues, i.description) }),
        status: "todo",
        priority: i.priority ?? "normal",
        ...(assigneeBotId && { assigneeBotId }),
        ...(i.conversationId && { conversationId: i.conversationId }),
        ...(i.groupId && { groupId: i.groupId }),
        createdBy: actor,
        createdAt: this.deps.clock.now(),
      },
      { events: (t) => [createdEvent(t, actor, t.createdAt)] },
    );
    this.changed(ticket);
    if (assigneeBotId && !(actor.kind === "bot" && actor.botId === assigneeBotId))
      await this.deps.wake(ticket, assigneeBotId, actor);
    return { ok: true, ticket };
  }

  /** A ticket with its comments. */
  get(ref: string): Promise<TicketResult<{ ticket: Ticket; comments: TicketComment[] }>> {
    return this.reads.get(ref);
  }

  /** A ticket with its merged timeline, the tickets it names and its comment count. */
  detail(ref: string): Promise<TicketResult<TicketDetail>> {
    return this.reads.detail(ref);
  }

  /** A page of tickets, newest first. */
  list(i: {
    status?: TicketStatus;
    assigneeBotId?: BotId;
    cursor?: string;
  }): Promise<TicketResult<{ tickets: Ticket[]; nextCursor?: string }>> {
    return this.reads.list(i);
  }

  async update(actor: Author, i: TicketUpdateInput): Promise<TicketResult<{ ticket: Ticket }>> {
    const cur = await this.reads.find(i.id);
    if (!cur) return NOT_FOUND;
    if (i.status !== undefined && !STATUSES.includes(i.status)) return BAD_STATUS;
    const title =
      i.title === undefined ? undefined : cleanText(this.deps.secretValues, i.title.trim());
    if (title !== undefined && (!title || title.length > TITLE_MAX)) return INVALID;
    if (i.description && i.description.length > DESCRIPTION_MAX) return INVALID;
    if (i.priority !== undefined && !PRIORITIES.includes(i.priority)) return INVALID;
    // The ticket's own group decides who may take it, not the acting session's.
    const refused = await assigneeRefusal(this.deps.store, i.assigneeBotId, cur.groupId);
    if (refused) return refused;
    const reason = i.blockedReason?.trim();
    const blocks = (i.status ?? cur.status) === "blocked";
    if (reason !== undefined && (!blocks || reason.length > BLOCKED_REASON_MAX)) return INVALID;
    // A ticket already blocked keeps its reason; moving into blocked needs one.
    if (blocks && cur.status !== "blocked" && !reason) return REASON_REQUIRED;
    const now = this.deps.clock.now();
    const ticket = await this.deps.store.tickets.update(
      cur.id,
      {
        ...(title !== undefined && { title }),
        // `null` clears the description.
        ...(i.description !== undefined && {
          description:
            i.description === null ? undefined : cleanText(this.deps.secretValues, i.description),
        }),
        ...(i.priority && { priority: i.priority }),
        ...(i.status && { status: i.status }),
        ...(i.assigneeBotId && { assigneeBotId: i.assigneeBotId }),
        ...(reason && { blockedReason: reason }),
        // A bot's conversation is the ticket's "last worked" one; the owner's is ignored.
        ...(actor.kind === "bot" && i.conversationId && { conversationId: i.conversationId }),
      },
      now,
      {
        ...(i.expectedUpdatedAt !== undefined && { ifUpdatedAt: i.expectedUpdatedAt }),
        // Written in the same transaction, so a conflict leaves no event behind.
        events: (prev, next) => ticketChangeEvents(prev, next, actor, now),
      },
    );
    if (ticket === "conflict") return CONFLICT;
    if (!ticket) return NOT_FOUND;
    this.changed(ticket);
    const to = i.assigneeBotId;
    const byActor = actor.kind === "bot" && actor.botId === to;
    if (to && to !== cur.assigneeBotId && !byActor && !finished(ticket.status))
      await this.deps.wake(ticket, to, actor);
    return { ok: true, ticket };
  }

  async comment(
    actor: Author,
    i: { id: string; body: string; conversationId?: ConversationId },
  ): Promise<TicketResult<{ comment: TicketComment }>> {
    const body = cleanText(this.deps.secretValues, i.body.trim());
    if (!body || body.length > COMMENT_MAX) return INVALID;
    const ticket = await this.reads.find(i.id);
    if (!ticket) return NOT_FOUND;
    const { store, clock } = this.deps;
    const comment = await store.tickets.addComment({
      ticketId: ticket.id,
      author: actor,
      body,
      createdAt: clock.now(),
    });
    // A bot commenting from another conversation becomes the ticket's "last worked" one.
    if (actor.kind === "bot" && i.conversationId && i.conversationId !== ticket.conversationId)
      await store.tickets.update(ticket.id, { conversationId: i.conversationId }, clock.now());
    const saved = await store.tickets.get(ticket.id);
    if (saved) this.changed(saved);
    return { ok: true, comment };
  }

  /** Tell `onChange`; a failing listener must never fail the change that was already saved. */
  private changed(t: Ticket): void {
    try {
      this.deps.onChange?.(t);
    } catch {
      // The app logs its own listener failures.
    }
  }
}
