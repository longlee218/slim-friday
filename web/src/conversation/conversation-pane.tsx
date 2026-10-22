import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import { useChat } from "../chat/chat-store";
import type { Chat } from "../chat/chat-types";
import { EASE_OUT, EXIT_FAST } from "../ui/motion-presets";
import { Composer } from "./composer";
import { DecisionBar } from "./decision-bar";
import { Feed } from "./feed";
import { Toolbar } from "./toolbar";

interface Props {
  chat: Chat;
  phone: boolean;
  inspectorOpen: boolean;
  onBack(): void;
  onToggleInspector(): void;
}

/** One open chat: toolbar, pinned decisions, feed, composer. Owns reply target and jump highlight. */
export function ConversationPane({ chat, phone, inspectorOpen, onBack, onToggleInspector }: Props) {
  const { runtime } = useChat();
  const [highlight, setHighlight] = useState<string | null>(null);
  // Reply target belongs to one chat; switching chats drops it.
  const [reply, setReply] = useState<{ chatId: string; messageId: string } | null>(null);
  const replyMsg = reply?.chatId === chat.id ? chat.messages.find((m) => m.id === reply.messageId) : undefined;

  // Scroll a message into view and flash it.
  const jump = useCallback((messageId: string) => {
    document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlight(messageId);
    window.setTimeout(() => setHighlight(null), 1400);
  }, []);

  const feed = (
    <Feed
      chat={chat}
      highlightId={highlight}
      onRetry={(mid) => runtime.retry(chat.id, mid)}
      onReply={(mid) => setReply({ chatId: chat.id, messageId: mid })}
      onJump={jump}
    />
  );

  return (
    <>
      <Toolbar chat={chat} inspectorOpen={inspectorOpen} onBack={onBack} onToggleInspector={onToggleInspector} />
      <DecisionBar key={`bar-${chat.id}`} chat={chat} onJump={jump} />
      {phone ? (
        feed
      ) : (
        // Desktop chat switch: the old feed fades out, the new one settles in from a soft blur.
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={chat.id}
            className="feed-slot"
            initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.28, ease: EASE_OUT } }}
            exit={{ opacity: 0, filter: "blur(2px)", transition: EXIT_FAST }}
          >
            {feed}
          </motion.div>
        </AnimatePresence>
      )}
      <Composer
        key={`composer-${chat.id}`}
        chat={chat}
        autoFocus={!phone}
        reply={replyMsg}
        onCancelReply={() => setReply(null)}
      />
    </>
  );
}
