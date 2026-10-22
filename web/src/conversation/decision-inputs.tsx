import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useRef, useState } from "react";
import type { ChoiceOption } from "../chat/chat-types";
import { Icon } from "../ui/icon";
import { SPRING_SNAPPY } from "../ui/motion-presets";

type Decide = (answer: string) => void;

/**
 * Yes/no answer as two full-width buttons on the card's bottom edge (alert style).
 * The positive action sits on the right and carries the accent.
 */
export function ConfirmBar({ no, yes, onDecide }: { no: string; yes: string; onDecide: Decide }) {
  return (
    <div className="confirm">
      <button type="button" className="confirm__btn" onClick={() => onDecide(no)}>
        {no}
      </button>
      <button type="button" className="confirm__btn confirm__btn--yes" onClick={() => onDecide(yes)}>
        {yes}
      </button>
    </div>
  );
}

/**
 * Pick one option, then send (iOS list style): edge-to-edge rows with inset
 * separators, a checkmark on the picked row, and a full-width Send bar on the
 * card's bottom edge. Native radios keep keyboard and screen reader behavior.
 */
export function ChoiceList({ id, options, onDecide }: { id: string; options: ChoiceOption[]; onDecide: Decide }) {
  const [pick, setPick] = useState<number | null>(null);
  return (
    <form
      className="choices"
      onSubmit={(e) => {
        e.preventDefault();
        if (pick !== null) onDecide(options[pick].label);
      }}
    >
      <div className="choices__list" role="radiogroup" aria-label="Options">
        {options.map((o, i) => (
          <label key={o.label} className="choice" data-on={pick === i || undefined}>
            <input type="radio" className="sr-only" name={`choice-${id}`} checked={pick === i} onChange={() => setPick(i)} />
            <span className="choice__text">
              <span>{o.label}</span>
              {o.hint && <small>{o.hint}</small>}
            </span>
            <span className="choice__check" aria-hidden="true">
              <AnimatePresence initial={false}>
                {pick === i && (
                  <motion.span
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.4, opacity: 0 }}
                    transition={SPRING_SNAPPY}
                  >
                    <Icon name="check" size={18} />
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
          </label>
        ))}
      </div>
      <button type="submit" className="choices__send" disabled={pick === null}>
        {pick === null ? "Pick one to send" : `Send “${options[pick].label}”`}
      </button>
    </form>
  );
}

/** Free-text answer: a small composer inside the card. Enter sends, Shift+Enter adds a line. */
export function TextAnswer({ onDecide }: { onDecide: Decide }) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const submit = () => {
    const v = text.trim();
    if (v) onDecide(v);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <form
      className="answer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={field}
        rows={1}
        value={text}
        placeholder="Type your answer"
        aria-label="Your answer"
        onKeyDown={onKey}
        onChange={(e) => {
          setText(e.target.value);
          const el = field.current;
          if (el) {
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
          }
        }}
      />
      <button type="submit" className="round round--send" disabled={!text.trim()} aria-label="Send answer">
        <Icon name="up" />
      </button>
    </form>
  );
}
