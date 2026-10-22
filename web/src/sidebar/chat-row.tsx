import { AnimatePresence, motion } from "motion/react";
import { chatTitle, useChat } from "../chat/chat-store";
import { type Chat, isPendingDecision } from "../chat/chat-types";
import { timeLabel } from "../chat/time-label";
import { useLongPress } from "../chat-actions/use-long-press";
import { ChatAvatar } from "../ui/avatar";
import { Icon } from "../ui/icon";
import { EXIT_FAST, SPRING_SOFT, SPRING_SNAPPY } from "../ui/motion-presets";

/** One-line preview of the newest meaningful message ("Name: text" in groups). */
function preview(chat: Chat, name: (id: string) => string): string {
  const m = [...chat.messages].reverse().find((x) => x.kind !== "stamp" && x.kind !== "route");
  if (!m) return "No messages yet";
  if (m.kind === "system") return m.text;
  const who = m.from === "me" ? "You: " : chat.kind === "group" ? `${name(m.from)}: ` : "";
  const body =
    m.kind === "text" ? m.text : m.kind === "file" ? m.name : m.kind === "task" ? m.title : m.kind === "approval" ? m.title : m.text;
  return who + body;
}

interface Props {
  chat: Chat;
  index: number;
  selected: boolean;
  /** Its action menu is open: the row stays highlighted. */
  menuOpen: boolean;
  avatarSize: number;
  onOpen(id: string): void;
  /** Open the action menu at a screen point. */
  onMenu(chat: Chat, x: number, y: number): void;
}

export function ChatRow({ chat, index, selected, menuOpen, avatarSize, onOpen, onMenu }: Props) {
  const { teammate } = useChat();
  const pending = chat.messages.filter(isPendingDecision).length;
  const title = chatTitle(chat, teammate);
  const press = useLongPress((x, y) => onMenu(chat, x, y));
  return (
    <motion.div
      layout="position"
      className="chat-row-wrap"
      data-menu={menuOpen || undefined}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, transition: EXIT_FAST }}
      transition={{ ...SPRING_SOFT, delay: Math.min(index, 8) * 0.03 }}
    >
      <button
        type="button"
        className="chat-row"
        data-selected={selected || undefined}
        aria-current={selected ? "page" : undefined}
        onClick={() => onOpen(chat.id)}
        {...press}
      >
        {/* Shared selection surface: slides from the old row to the new one. */}
        {selected && <motion.span layoutId="chat-selection" className="chat-row__pill" transition={SPRING_SNAPPY} />}
        <ChatAvatar chat={chat} size={avatarSize} />
        <span className="chat-row__text">
          <span className="chat-row__line">
            <span className="chat-row__name">{title}</span>
            <span className="chat-row__time">{timeLabel(chat.updatedAt)}</span>
          </span>
          <span className="chat-row__line">
            <span className="chat-row__preview">{preview(chat, (id) => teammate(id)?.name ?? "")}</span>
            <AnimatePresence mode="popLayout" initial={false}>
              {pending > 0 ? (
                <motion.span
                  key={`badge-${pending}`}
                  className="badge"
                  aria-label={`${pending} waiting for you`}
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.4, opacity: 0 }}
                  transition={SPRING_SNAPPY}
                >
                  {pending}
                </motion.span>
              ) : chat.unread ? (
                <motion.span
                  key="dot"
                  className="unread-dot"
                  role="img"
                  aria-label="Unread"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  transition={SPRING_SNAPPY}
                />
              ) : null}
            </AnimatePresence>
          </span>
        </span>
      </button>
      {/* Desktop: shows on hover in place of the time. Touch uses a long press instead. */}
      <button
        type="button"
        className="tool chat-row__more"
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(chat, r.left, r.bottom + 4);
        }}
      >
        <Icon name="more" />
      </button>
    </motion.div>
  );
}
