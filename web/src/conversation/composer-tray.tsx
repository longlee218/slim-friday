import { AnimatePresence, motion } from "motion/react";
import type { Attachment, Message } from "../chat/chat-types";
import { Icon } from "../ui/icon";
import { EXIT_FAST, SPRING_SNAPPY, SPRING_SOFT } from "../ui/motion-presets";
import { MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE } from "../chat/attachment-limits";
import { fileExt, firstImage, formatBytes, snippet } from "./message-snippet";
import { useSenderName } from "./reply-quote";

/** Height-unfolding strip inside the composer box. */
const UNFOLD = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1, transition: SPRING_SOFT },
  exit: { height: 0, opacity: 0, transition: EXIT_FAST },
} as const;

interface Props {
  reply: Message | undefined;
  onCancelReply(): void;
  files: Attachment[];
  /** Why some files were not added (size or count limit). */
  notice: string | null;
  onRemove(id: string): void;
}

/** Covers the conversation while files are dragged over the page. */
export function DropOverlay({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="drop"
          className="drop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: EXIT_FAST }}
        >
          <motion.div
            className="drop__target"
            initial={{ scale: 0.94, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            transition={SPRING_SOFT}
          >
            <Icon name="image" size={28} />
            <b>Drop to attach</b>
            <span>Up to {MAX_FILES_PER_MESSAGE} files, {formatBytes(MAX_FILE_BYTES)} each</span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Above the message field: the message being replied to, then the files waiting to send. */
export function ComposerTray({ reply, onCancelReply, files, notice, onRemove }: Props) {
  const name = useSenderName();
  const thumb = reply && firstImage(reply);
  return (
    <AnimatePresence initial={false}>
      {reply && (
        <motion.div key={`reply-${reply.id}`} className="tray-reply" {...UNFOLD}>
          <span className="tray-reply__inner">
            <Icon name="reply" size={14} />
            {thumb && <img className="quote__thumb" src={thumb} alt="" />}
            <span className="tray-reply__text">
              <b>Replying to {name(reply)}</b>
              <span>{snippet(reply)}</span>
            </span>
            <button type="button" className="tool" onClick={onCancelReply} aria-label="Cancel reply">
              <Icon name="x" size={14} />
            </button>
          </span>
        </motion.div>
      )}
      {notice && (
        <motion.p key="notice" className="tray-notice" role="alert" {...UNFOLD}>
          {notice}
        </motion.p>
      )}
      {files.length > 0 && (
        <motion.div key="files" className="tray-files" {...UNFOLD}>
          <div className="tray-files__row">
            <AnimatePresence initial={false} mode="popLayout">
              {files.map((a) => (
                <motion.div
                  key={a.id}
                  layout
                  className="tray-item"
                  data-type={a.type}
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  transition={SPRING_SNAPPY}
                >
                  {a.type === "image" ? (
                    <img src={a.url} alt={a.name} />
                  ) : (
                    <span className="tray-item__file">
                      <span className="file__ext">{fileExt(a.name)}</span>
                      <span className="tray-item__name">{a.name}</span>
                    </span>
                  )}
                  <button type="button" className="tray-item__x" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`}>
                    <Icon name="x" size={10} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
