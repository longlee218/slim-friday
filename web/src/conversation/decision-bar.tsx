import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useChat } from "../chat/chat-store";
import { type Chat, isPendingDecision } from "../chat/chat-types";
import { Avatar } from "../ui/avatar";
import { Icon } from "../ui/icon";
import { EXIT_FAST, SPRING_SNAPPY, SPRING_SOFT } from "../ui/motion-presets";

/**
 * Pinned under the toolbar while decisions wait in this chat.
 * Each click jumps to the next pending card, cycling through them.
 * It unfolds when the first decision arrives and folds away when the last is answered.
 */
export function DecisionBar({ chat, onJump }: { chat: Chat; onJump(messageId: string): void }) {
  const { teammate } = useChat();
  const [cursor, setCursor] = useState(0);
  const pending = chat.messages.filter(isPendingDecision);
  const current = pending.length > 0 ? pending[cursor % pending.length] : undefined;
  const shown = current && (current.kind === "approval" || current.kind === "question") ? current : undefined;
  const who = shown ? teammate(shown.from) : undefined;
  const summary = shown ? (shown.kind === "approval" ? shown.title : shown.text) : "";

  return (
    <AnimatePresence initial={false}>
      {shown && (
        <motion.div
          key="bar"
          className="decision-bar__wrap"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1, transition: SPRING_SOFT }}
          exit={{ height: 0, opacity: 0, transition: { ...EXIT_FAST, delay: 0.35 } }}
        >
          <button
            type="button"
            className="decision-bar"
            onClick={() => {
              onJump(shown.id);
              setCursor((c) => c + 1);
            }}
          >
            {/* The count rolls: the new number drops in from above. */}
            <span className="decision-bar__count">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={pending.length}
                  className="decision-bar__num"
                  initial={{ y: -12, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: 12, opacity: 0 }}
                  transition={SPRING_SNAPPY}
                >
                  {pending.length}
                </motion.span>
              </AnimatePresence>{" "}
              need you
            </span>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={shown.id}
                className="decision-bar__item"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.18 }}
              >
                {who && <Avatar name={who.avatar} size={18} />}
                <span className="decision-bar__text">{summary}</span>
              </motion.span>
            </AnimatePresence>
            <span className="decision-bar__go">
              {pending.length > 1 ? "Next" : "Show"}
              <Icon name="arrow" size={12} />
            </span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
