import { chatTitle, useChat } from "../chat/chat-store";
import type { Chat } from "../chat/chat-types";
import { ROLE_LABEL } from "../chat/role-labels";
import { ChatAvatar } from "../ui/avatar";
import { Icon } from "../ui/icon";

const RUN_LABEL = { running: "Working", paused: "Paused at limit", stopped: "Stopped" } as const;

interface Props {
  chat: Chat;
  inspectorOpen: boolean;
  onBack(): void;
  onToggleInspector(): void;
}

/** Unified window toolbar: who this chat is with, its limits, run and connection status. */
export function Toolbar({ chat, inspectorOpen, onBack, onToggleInspector }: Props) {
  const { teammate, state } = useChat();
  const subtitle =
    chat.kind === "group"
      ? `${chat.members.length} members · ${chat.caps.turns}/${chat.caps.maxTurns} turns · $${chat.caps.cost.toFixed(2)} of $${chat.caps.maxCost}`
      : ROLE_LABEL[teammate(chat.with)?.role ?? "lead"];
  const run = chat.kind === "group" && chat.run !== "idle" ? chat.run : null;

  return (
    <header className="toolbar">
      <button type="button" className="tool show-phone" onClick={onBack} aria-label="Back to chats">
        <Icon name="back" />
      </button>
      <ChatAvatar chat={chat} size={28} />
      <div className="toolbar__title">
        <h2>{chatTitle(chat, teammate)}</h2>
        <span className="toolbar__sub">{subtitle}</span>
      </div>
      {state.connection !== "online" ? (
        <span className="status" data-tone="bad" role="status">
          {state.connection === "offline" ? "Offline" : "Connecting…"}
        </span>
      ) : run ? (
        <span className="status" data-tone={run === "running" ? "good" : "muted"} role="status">
          {RUN_LABEL[run]}
        </span>
      ) : null}
      <button
        type="button"
        className="tool"
        onClick={onToggleInspector}
        aria-pressed={inspectorOpen}
        aria-label="Details"
        title="Details"
      >
        <Icon name="info" />
      </button>
    </header>
  );
}
