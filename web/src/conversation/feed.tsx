import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChat } from "../chat/chat-store";
import type { Chat } from "../chat/chat-types";
import { ROLE_LABEL } from "../chat/role-labels";
import { Avatar } from "../ui/avatar";
import { EXIT_FAST, SPRING_SOFT } from "../ui/motion-presets";
import { Lightbox } from "./lightbox";
import { type FeedActions, MessageItem } from "./message-item";

interface Props {
  chat: Chat;
  highlightId: string | null;
  onRetry(messageId: string): void;
  onReply(messageId: string): void;
  onJump(messageId: string): void;
}

/** Scrollable conversation; sticks to the bottom unless the owner scrolled up. */
export function Feed({ chat, highlightId, onRetry, onReply, onJump }: Props) {
  const { teammate, state } = useChat();
  const [photo, setPhoto] = useState<string | null>(null);
  const actions: FeedActions = { retry: onRetry, reply: onReply, jump: onJump, openImage: setPhoto };
  // Every photo in this chat, oldest first, so the viewer can step through them.
  const gallery = chat.messages.flatMap((m) =>
    m.kind === "text" ? (m.attachments ?? []).filter((a) => a.type === "image") : [],
  );
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const typingId = state.typing[chat.id];
  const typer = typingId ? teammate(typingId) : undefined;

  // New chat opened: start at the newest message.
  useLayoutEffect(() => {
    stick.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.id]);

  // New message or typing: follow only when already near the bottom.
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [chat.messages.length, typingId]);

  const empty = chat.messages.length === 0 && chat.kind === "direct";
  const peer = chat.kind === "direct" ? teammate(chat.with) : undefined;

  return (
    <div
      className="feed"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="feed__column" role="log" aria-live="polite" aria-relevant="additions">
        {empty && peer ? (
          <motion.div
            className="feed__empty"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={SPRING_SOFT}
          >
            <Avatar name={peer.avatar} size={64} />
            <b>{peer.name}</b>
            <span>{ROLE_LABEL[peer.role]}. Say what you need.</span>
          </motion.div>
        ) : (
          // Messages already in the chat render still; only new arrivals animate in.
          <AnimatePresence initial={false}>
            {chat.messages.map((m, i) => (
              <MessageItem key={m.id} chat={chat} index={i} highlighted={m.id === highlightId} actions={actions} />
            ))}
          </AnimatePresence>
        )}
        <AnimatePresence>
          {typer && (
            <motion.div
              key="typing"
              className="typing"
              aria-label={`${typer.name} is typing`}
              initial={{ opacity: 0, y: 8, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING_SOFT }}
              exit={{ opacity: 0, scale: 0.9, transition: EXIT_FAST }}
              style={{ transformOrigin: "left bottom" }}
            >
              <Avatar name={typer.avatar} size={24} />
              <span className="typing__dots">
                <i />
                <i />
                <i />
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <Lightbox images={gallery} openId={photo} onChange={setPhoto} />
    </div>
  );
}
