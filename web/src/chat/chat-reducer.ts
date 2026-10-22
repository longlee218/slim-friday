import type { Chat, Connection, DirectChat, GroupChat, Message, Teammate } from "./chat-types";

/** Whole screen state; one reducer keeps updates immutable and testable. */
export interface ChatState {
  team: Teammate[];
  chats: Chat[];
  activeId: string | null;
  /** Chat id -> teammate id currently typing there. */
  typing: Record<string, string | undefined>;
  connection: Connection;
  /** Owner spend today, USD. */
  spend: number;
}

export type ChatAction =
  | { type: "select"; chatId: string }
  | { type: "append"; chatId: string; message: Message }
  | { type: "decide"; chatId: string; messageId: string; answer: string }
  | { type: "markFailed"; chatId: string; messageId: string; failed: boolean }
  | { type: "uploaded"; chatId: string; messageId: string }
  | { type: "addTeammate"; teammate: Teammate; chat: DirectChat }
  | { type: "addGroup"; chat: GroupChat }
  | { type: "setGroupMemory"; chatId: string; memory: string; at: number }
  | { type: "updateGroup"; chatId: string; name: string; description: string }
  | { type: "removeChat"; chatId: string }
  | { type: "removeTeammate"; teammateId: string }
  | { type: "setUnread"; chatId: string; unread: boolean }
  | { type: "typing"; chatId: string; teammateId?: string }
  | { type: "groupRun"; chatId: string; run: GroupChat["run"] }
  | { type: "groupTurn"; chatId: string; cost: number }
  | { type: "connection"; value: Connection };

/** Apply a change to one chat, leaving the rest untouched. */
function mapChat(state: ChatState, chatId: string, fn: (c: Chat) => Chat): ChatState {
  return { ...state, chats: state.chats.map((c) => (c.id === chatId ? fn(c) : c)) };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "select":
      return {
        ...mapChat(state, action.chatId, (c) => ({ ...c, unread: false })),
        activeId: action.chatId,
      };
    case "append":
      // New activity moves the chat to the top and marks it unread when not open.
      return mapChat(state, action.chatId, (c) => ({
        ...c,
        messages: [...c.messages, action.message],
        updatedAt: Date.now(),
        unread: state.activeId !== c.id && action.message.kind !== "stamp",
      }));
    case "decide":
      return mapChat(state, action.chatId, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === action.messageId && (m.kind === "approval" || m.kind === "question")
            ? { ...m, state: action.answer }
            : m,
        ),
      }));
    case "markFailed":
      return mapChat(state, action.chatId, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === action.messageId && m.kind === "text" ? { ...m, failed: action.failed } : m,
        ),
      }));
    case "uploaded":
      // Every attachment of the message finished uploading.
      return mapChat(state, action.chatId, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === action.messageId && m.kind === "text" && m.attachments
            ? { ...m, attachments: m.attachments.map((a) => ({ ...a, uploading: false })) }
            : m,
        ),
      }));
    case "addTeammate":
      // A new teammate comes with its direct chat, opened at once.
      return {
        ...state,
        team: [...state.team, action.teammate],
        chats: [action.chat, ...state.chats],
        activeId: action.chat.id,
      };
    case "addGroup":
      return { ...state, chats: [action.chat, ...state.chats], activeId: action.chat.id };
    case "setGroupMemory":
      return mapChat(state, action.chatId, (c) =>
        c.kind === "group" ? { ...c, memory: action.memory, memoryUpdatedAt: action.at } : c,
      );
    case "updateGroup":
      return mapChat(state, action.chatId, (c) =>
        c.kind === "group" ? { ...c, name: action.name, description: action.description } : c,
      );
    case "removeChat":
      return {
        ...state,
        chats: state.chats.filter((c) => c.id !== action.chatId),
        activeId: state.activeId === action.chatId ? null : state.activeId,
      };
    case "removeTeammate": {
      // The teammate leaves with its direct chat; the UI only offers this when it is in no group.
      const direct = state.chats.find((c) => c.kind === "direct" && c.with === action.teammateId);
      return {
        ...state,
        team: state.team.filter((t) => t.id !== action.teammateId),
        chats: state.chats.filter((c) => c !== direct),
        activeId: direct && state.activeId === direct.id ? null : state.activeId,
      };
    }
    case "setUnread":
      return mapChat(state, action.chatId, (c) => ({ ...c, unread: action.unread }));
    case "typing":
      return { ...state, typing: { ...state.typing, [action.chatId]: action.teammateId } };
    case "groupRun":
      return mapChat(state, action.chatId, (c) =>
        c.kind === "group" ? { ...c, run: action.run } : c,
      );
    case "groupTurn":
      return {
        ...mapChat(state, action.chatId, (c) =>
          c.kind === "group"
            ? {
                ...c,
                caps: {
                  ...c.caps,
                  turns: c.caps.turns + 1,
                  cost: +(c.caps.cost + action.cost).toFixed(2),
                },
              }
            : c,
        ),
        spend: +(state.spend + action.cost).toFixed(2),
      };
    case "connection":
      return { ...state, connection: action.value };
  }
}
