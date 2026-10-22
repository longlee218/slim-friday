import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useChat } from "../chat/chat-store";
import type { GroupChat } from "../chat/chat-types";
import { timeLabel } from "../chat/time-label";
import { EXIT_FAST, SPRING_SOFT } from "../ui/motion-presets";
import { MarkdownView, PageHeader } from "./inspector-parts";

/**
 * Shared memory of a group: every member reads it. View as formatted text,
 * or edit the markdown. While editing, Back is hidden so changes are never lost silently.
 */
export function GroupMemoryPage({ chat, onBack }: { chat: GroupChat; onBack(): void }) {
  const { runtime } = useChat();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.memory);
  const [saved, setSaved] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const dirty = draft.trim() !== chat.memory.trim();

  // Start editing: load the current text and put the caret at the end.
  const edit = () => {
    setDraft(chat.memory);
    setEditing(true);
  };
  useEffect(() => {
    const el = field.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 1800);
    return () => window.clearTimeout(t);
  }, [saved]);

  const save = () => {
    if (!dirty) return setEditing(false);
    runtime.saveGroupMemory(chat.id, draft.trim());
    setEditing(false);
    setSaved(true);
  };
  // ⌘/Ctrl+Enter saves; Esc cancels without closing the inspector.
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setEditing(false);
    }
  };

  const action = editing ? null : (
    <button type="button" className="btn" onClick={edit}>
      Edit
    </button>
  );

  return (
    <div className="page">
      <PageHeader title="Group memory" onBack={editing ? undefined : onBack} action={action} />
      <p className="page__note">
        Every member of {chat.name} reads this before it answers.
        <AnimatePresence>
          {saved && (
            <motion.span
              key="saved"
              className="page__saved"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, transition: SPRING_SOFT }}
              exit={{ opacity: 0, transition: EXIT_FAST }}
            >
              Saved
            </motion.span>
          )}
        </AnimatePresence>
      </p>

      <AnimatePresence mode="wait" initial={false}>
        {editing ? (
          <motion.div
            key="edit"
            className="memory-edit"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: SPRING_SOFT }}
            exit={{ opacity: 0, transition: EXIT_FAST }}
          >
            <textarea
              ref={field}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              aria-label="Group memory, markdown"
              placeholder={"# Goal\n- What every member should know"}
              spellCheck
            />
            <div className="memory-edit__bar">
              <span className="memory-edit__hint">Markdown · {draft.length.toLocaleString()} chars</span>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" onClick={save} disabled={!dirty}>
                Save
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="view"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: SPRING_SOFT }}
            exit={{ opacity: 0, transition: EXIT_FAST }}
          >
            {chat.memory ? (
              <>
                <MarkdownView text={chat.memory} />
                {chat.memoryUpdatedAt && <p className="page__foot">Updated {timeLabel(chat.memoryUpdatedAt)}</p>}
              </>
            ) : (
              <div className="page__blank">
                <b>No group memory yet</b>
                <span>Add the goal, decisions and rules every member should keep in mind.</span>
                <button type="button" className="btn btn--primary" onClick={edit}>
                  Write memory
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
