import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../chat/chat-types";
import { Icon } from "../ui/icon";
import { SPRING_SOFT } from "../ui/motion-presets";
import { formatBytes } from "./message-snippet";

interface Props {
  /** Every photo of the chat, in feed order; arrows step through them. */
  images: Attachment[];
  openId: string | null;
  onChange(id: string | null): void;
}

/**
 * Full-screen photo viewer. The photo zooms out of its thumbnail (shared layoutId)
 * and back into it on close. Rendered in a portal so no transformed parent clips it.
 */
export function Lightbox({ images, openId, onChange }: Props) {
  const index = images.findIndex((a) => a.id === openId);
  const img = index >= 0 ? images[index] : undefined;
  const step = (d: number) => {
    const next = images[index + d];
    if (next) onChange(next.id);
  };

  // Esc closes; arrow keys move between photos.
  useEffect(() => {
    if (!img) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onChange(null);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return createPortal(
    <AnimatePresence>
      {img && (
        <motion.div
          key="lightbox"
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={img.name}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.2 } }}
          onClick={() => onChange(null)}
        >
          <motion.img
            key={img.id}
            layoutId={`img-${img.id}`}
            src={img.url}
            alt={img.name}
            className="lightbox__img"
            transition={SPRING_SOFT}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="lightbox__bar" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="tool" onClick={() => step(-1)} disabled={index <= 0} aria-label="Previous photo">
              <Icon name="back" />
            </button>
            <span className="lightbox__name">
              <b>{img.name}</b>
              <span>
                {formatBytes(img.size)} · {index + 1} of {images.length}
              </span>
            </span>
            <button type="button" className="tool" onClick={() => step(1)} disabled={index >= images.length - 1} aria-label="Next photo">
              <Icon name="next" />
            </button>
            <button type="button" className="tool" onClick={() => onChange(null)} aria-label="Close photo">
              <Icon name="x" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
