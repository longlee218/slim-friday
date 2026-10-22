import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { EXIT_FAST, SPRING_SOFT } from "./motion-presets";

interface Props {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
}

/**
 * Small modal: dimmed backdrop, centered card (bottom sheet on phone).
 * Focuses the first field or button, Esc and a backdrop click close it,
 * and focus returns to where it was.
 */
export function Dialog({ open, title, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    // First a field, else the button marked safe to focus (Cancel on a destructive dialog).
    const card = ref.current;
    (card?.querySelector<HTMLElement>("input, textarea") ?? card?.querySelector<HTMLElement>("[data-autofocus]"))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      back?.focus?.();
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="dialog"
          className="dialog"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: EXIT_FAST }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={ref}
            className="dialog__card"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING_SOFT }}
            exit={{ opacity: 0, y: 12, scale: 0.98, transition: EXIT_FAST }}
          >
            <h2 id={titleId}>{title}</h2>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
