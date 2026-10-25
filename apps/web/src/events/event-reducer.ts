import type {
  ApprovalCardDto,
  BotStatusDto,
  FridayEvent,
  MessageDto,
  QuestionAnswerDto,
  QuestionCardDto,
  RunStepDto,
  TicketDto,
} from "@friday/contracts";

/** One cache change (or side effect) derived from a server event. */
export type CacheEffect =
  | { op: "appendMessage"; message: MessageDto }
  /** `conversationId` "*" = every conversation with a live run. */
  | { op: "endRun"; conversationId: string; botId: string }
  | { op: "startRun"; conversationId: string; botId: string; at: number }
  | { op: "runStep"; conversationId: string; botId: string; step: RunStepDto }
  | { op: "runTail"; conversationId: string; botId: string; label: string }
  | { op: "openApproval"; card: ApprovalCardDto }
  | { op: "closeApproval"; cardId: string; answer: "once" | "always" | "deny" | null }
  | { op: "openQuestion"; card: QuestionCardDto }
  | { op: "closeQuestion"; cardId: string; answer: QuestionAnswerDto | null }
  | { op: "setUnread"; conversationId: string; unread: number }
  | { op: "setStatus"; bots: BotStatusDto[] }
  | { op: "refetchStatus" }
  | { op: "patchTicket"; ticket: TicketDto }
  | { op: "invalidate"; scope: "tickets" | "config" | "all" }
  /** An OAuth MCP server changed sign-in state: refetch the list; toast when it lost its login. */
  | { op: "mcpAuth"; server: string; status: "connected" | "needs_login" | "never" }
  | { op: "notify"; conversationId: string; botId?: string; title: string; text: string };

/** What the reducer needs to know about the screen. */
export interface ReducerView {
  activeConversationId: string | null;
  /** The tab is visible. */
  visible: boolean;
  now: number;
}

/**
 * Pure mapping from a server event to cache effects. A toast (finished notice or card) is raised
 * only when the user is not looking at the conversation (other chat, or hidden tab).
 */
export function reduceEvent(e: FridayEvent, view: ReducerView): CacheEffect[] {
  const away = (conversationId: string) =>
    conversationId !== view.activeConversationId || !view.visible;

  switch (e.type) {
    case "message": {
      const out: CacheEffect[] = [{ op: "appendMessage", message: e.message }];
      const author = e.message.author;
      if (author.kind === "bot") {
        out.push({ op: "endRun", conversationId: e.conversationId, botId: author.botId });
        out.push({ op: "refetchStatus" });
        // No toast here: a bot's final answer to the owner arrives as `run.finished` (progress,
        // ticket and bot-to-bot messages raise none).
      }
      return out;
    }
    case "run.finished":
      return away(e.conversationId)
        ? [
            {
              op: "notify",
              conversationId: e.conversationId,
              botId: e.botId,
              title: e.botId,
              text: e.preview,
            },
          ]
        : [];
    case "activity": {
      const out: CacheEffect[] = [{ op: "refetchStatus" }];
      if (e.kind === "typing") {
        out.push({
          op: "startRun",
          conversationId: e.conversationId,
          botId: e.botId,
          at: view.now,
        });
      } else if (e.label) {
        out.push({
          op: "runTail",
          conversationId: e.conversationId,
          botId: e.botId,
          label: e.label,
        });
      }
      return out;
    }
    case "run": {
      const out: CacheEffect[] = [
        { op: "runStep", conversationId: e.conversationId, botId: e.botId, step: e.step },
      ];
      if (e.step.kind === "subagent") out.push({ op: "refetchStatus" });
      return out;
    }
    case "approval.opened": {
      const out: CacheEffect[] = [{ op: "openApproval", card: e.card }];
      if (away(e.card.conversationId)) out.push(notifyCard(e.card, e.card.summary));
      return out;
    }
    case "question.opened": {
      const out: CacheEffect[] = [{ op: "openQuestion", card: e.card }];
      if (away(e.card.conversationId)) out.push(notifyCard(e.card, e.card.question));
      return out;
    }
    case "approval.closed":
      return [{ op: "closeApproval", cardId: e.cardId, answer: e.answer }];
    case "question.closed":
      return [{ op: "closeQuestion", cardId: e.cardId, answer: e.answer }];
    case "unread":
      return [{ op: "setUnread", conversationId: e.conversationId, unread: e.unread }];
    case "status":
      // setStatus also ends the runs of every bot the list does not show as working.
      return [{ op: "setStatus", bots: e.bots }];
    case "ticket":
      return [{ op: "patchTicket", ticket: e.ticket }];
    case "config.changed":
      return [{ op: "invalidate", scope: "config" }];
    case "resync":
      return [{ op: "invalidate", scope: "all" }];
    case "mcp.auth":
      return [{ op: "mcpAuth", server: e.server, status: e.status }];
  }
}

/** A toast for a card: bot name as title, the card text as body. */
function notifyCard(
  card: { conversationId: string; botId: string; botName: string },
  text: string,
): CacheEffect {
  return {
    op: "notify",
    conversationId: card.conversationId,
    botId: card.botId,
    title: card.botName,
    text,
  };
}
