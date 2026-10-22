import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { Icon } from "../ui/icon";
import { EXIT_FAST, SPRING_SOFT } from "../ui/motion-presets";
import { Segmented } from "./form-parts";
import { NewGroupForm } from "./new-group-form";
import { NewTeammateForm } from "./new-teammate-form";

export type NewKind = "teammate" | "group";
const KINDS = [
  { value: "teammate", label: "Teammate" },
  { value: "group", label: "Group" },
] as const;

interface Props {
  kind: NewKind;
  onKind(k: NewKind): void;
  onCancel(): void;
  /** Called with the new chat's id. */
  onDone(chatId: string): void;
}

/** Fills the conversation column: create a teammate or a group, then open its chat. */
export function NewChat({ kind, onKind, onCancel, onDone }: Props) {
  // Esc leaves without creating anything.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="new-chat">
      <div className="toolbar">
        <button type="button" className="tool" onClick={onCancel} aria-label="Cancel">
          <Icon name="back" />
        </button>
        <div className="toolbar__title">
          <h2>{kind === "teammate" ? "New teammate" : "New group"}</h2>
        </div>
      </div>
      <div className="new-chat__scroll">
        <div className="new-chat__column">
          <Segmented id="new-kind" label="Create" options={KINDS} value={kind} onChange={onKind} />
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={kind}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0, transition: SPRING_SOFT }}
              exit={{ opacity: 0, y: -6, transition: EXIT_FAST }}
            >
              {kind === "teammate" ? <NewTeammateForm onDone={onDone} /> : <NewGroupForm onDone={onDone} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
