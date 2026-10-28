import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { GroupId } from "../domain/group";
import type { Author } from "../domain/message";
import type { Clock } from "../ports/clock";
import type { Store } from "../ports/store";
import type { Ticket, TicketComment, TicketPriority, TicketStatus } from "./ticket";
import { assigneeRefusal } from "./ticket-assignee";
import {
  CONFLICT,
  cleanText,
  DESCRIPTION_MAX,
  INVALID,
  NOT_FOUND,
  PRIORITIES,
  type StatusChange,
  TITLE_MAX,
  type TicketResult,
  type TicketUpdateInput,
} from "./ticket-board-rules";
import { createdEvent, ticketChangeEvents } from "./ticket-change-events";
import { addTicketComment } from "./ticket-comment";
import { readyToWork, resolveBlockers } from "./ticket-dependencies";
import { type TicketDetail, TicketReads } from "./ticket-reads";
import { checkUpdate } from "./ticket-update-checks";

export type { StatusChange, TicketErrorCode, TicketResult } from "./ticket-board-rules";

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
      /** Told after a saved update that changed the status (see `StatusChange`); errors stay here. */
      onStatusChange?: (t: Ticket, change: StatusChange) => Promise<void>;
      /** Told after a saved comment, and after a blocked ticket got a new reason; errors stay here. */
      onComment?: (t: Ticket, c: TicketComment) => Promise<void>;
      onBlockedReason?: (t: Ticket) => Promise<void>;
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
      /** Refs or ids of the tickets to wait on; the assignee is woken when they finish. */
      blockedBy?: string[];
    },
  ): Promise<TicketResult<{ ticket: Ticket }>> {
    const title = cleanText(this.deps.secretValues, i.title.trim());
    if (!title || title.length > TITLE_MAX) return INVALID;
    if (i.description !== undefined && i.description.length > DESCRIPTION_MAX) return INVALID;
    if (i.priority !== undefined && !PRIORITIES.includes(i.priority)) return INVALID;
    const assigneeBotId = i.assigneeBotId ?? (actor.kind === "bot" ? actor.botId : undefined);
    const refused = await assigneeRefusal(this.deps.store, assigneeBotId, i.groupId);
    if (refused) return refused;
    const deps = await resolveBlockers(this.deps.store, undefined, i.blockedBy ?? []);
    if (!deps.ok) return deps;
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
        ...(deps.ids.length > 0 && { blockedBy: deps.ids }),
        createdBy: actor,
        createdAt: this.deps.clock.now(),
      },
      { events: (t) => [createdEvent(t, actor, t.createdAt)] },
    );
    this.changed(ticket);
    const self = actor.kind === "bot" && actor.botId === assigneeBotId;
    if (assigneeBotId && !self && (await readyToWork(this.deps.store, ticket)))
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
    const checked = await checkUpdate(this.deps.store, this.deps.secretValues, cur, actor, i);
    if (!checked.ok) return checked;
    const { title, reason, blockedBy } = checked;
    const now = this.deps.clock.now();
    let statusEventId: string | undefined;
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
        ...(blockedBy && { blockedBy }),
        // A bot's conversation is the ticket's "last worked" one; the owner's is ignored.
        ...(actor.kind === "bot" && i.conversationId && { conversationId: i.conversationId }),
      },
      now,
      {
        ...(i.expectedUpdatedAt !== undefined && { ifUpdatedAt: i.expectedUpdatedAt }),
        // Written in the same transaction, so a conflict leaves no event behind.
        events: (prev, next) => {
          const events = ticketChangeEvents(prev, next, actor, now);
          statusEventId = events.find((e) => e.kind === "status")?.id;
          return events;
        },
      },
    );
    if (ticket === "conflict") return CONFLICT;
    if (!ticket) return NOT_FOUND;
    this.changed(ticket);
    // The store writes the events in the update; their status entry keys the follow-up wakes.
    if (ticket.status !== cur.status && statusEventId)
      await this.deps
        .onStatusChange?.(ticket, {
          from: cur.status,
          actor,
          eventId: statusEventId,
          assigneeChanged: ticket.assigneeBotId !== cur.assigneeBotId,
        })
        .catch(() => {});
    else if (reason && ticket.status === "blocked" && reason !== cur.blockedReason)
      await this.deps.onBlockedReason?.(ticket).catch(() => {});
    const to = i.assigneeBotId;
    const byActor = actor.kind === "bot" && actor.botId === to;
    if (to && to !== cur.assigneeBotId && !byActor && (await readyToWork(this.deps.store, ticket)))
      await this.deps.wake(ticket, to, actor);
    return { ok: true, ticket };
  }

  async comment(
    actor: Author,
    i: { id: string; body: string; conversationId?: ConversationId; commentId?: string },
  ): Promise<TicketResult<{ comment: TicketComment; created: boolean }>> {
    const r = await addTicketComment(this.deps, this.reads, actor, i);
    if (!r.ok) return r;
    if (r.saved) {
      this.changed(r.saved);
      await this.deps.onComment?.(r.saved, r.comment).catch(() => {});
    }
    return { ok: true, comment: r.comment, created: r.created };
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
