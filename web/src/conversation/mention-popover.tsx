import { AnimatePresence, motion } from "motion/react";
import type { Teammate } from "../chat/chat-types";
import { ROLE_LABEL } from "../chat/role-labels";
import { Avatar } from "../ui/avatar";
import { SPRING_SNAPPY } from "../ui/motion-presets";

interface Props {
  /** Teammates matching the @word under the caret; empty hides the popover. */
  mentions: (Teammate | undefined)[];
  /** Index of the highlighted option (wraps around). */
  pick: number;
  onPick(name: string): void;
}

/** @mention suggestions above the composer; keeps focus in the field while clicking. */
export function MentionPopover({ mentions, pick, onPick }: Props) {
  return (
    <AnimatePresence>
      {mentions.length > 0 && (
        <motion.div
          key="mentions"
          className="popover composer__mentions"
          role="listbox"
          aria-label="Mention a teammate"
          initial={{ opacity: 0, y: 6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.1 } }}
          transition={SPRING_SNAPPY}
          style={{ transformOrigin: "left bottom" }}
        >
          {mentions.map((t, i) =>
            t ? (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={i === pick % mentions.length}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(t.name)}
              >
                <Avatar name={t.avatar} size={20} />
                {t.name}
                <small>{ROLE_LABEL[t.role]}</small>
              </button>
            ) : null,
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
