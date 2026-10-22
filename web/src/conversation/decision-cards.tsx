import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useRef } from "react";
import type { Message } from "../chat/chat-types";
import { Icon } from "../ui/icon";
import { EASE_OUT, EXIT_FAST, SPRING_SOFT } from "../ui/motion-presets";
import { ChoiceList, ConfirmBar, TextAnswer } from "./decision-inputs";

type Approval = Extract<Message, { kind: "approval" }>;
type Question = Extract<Message, { kind: "question" }>;
type Decide = (answer: string) => void;

/** Check mark that draws itself; used when the owner just made the decision. */
function DrawnCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <motion.path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.42, delay: 0.14, ease: EASE_OUT }}
      />
    </svg>
  );
}

type Tone = "good" | "bad" | "muted";

/** Outcome line once decided or expired. `fresh` = decided in this view, so the check draws. */
function Outcome({ tone, label, fresh, children }: { tone: Tone; label: string; fresh: boolean; children?: ReactNode }) {
  const icon = tone === "bad" ? <Icon name="clock" size={14} /> : fresh ? <DrawnCheck /> : <Icon name="check" size={14} />;
  return (
    <div className="outcome-block">
      <span className="outcome" data-tone={tone}>
        {icon}
        {label}
      </span>
      {children}
    </div>
  );
}

const EXPIRED = "Expired. Ask again in chat";

/**
 * Card footer that swaps the pending input for the outcome: the input folds away,
 * the outcome unfolds, and the card height follows. `flush` = footer touches the card edges.
 */
function Footer({ pending, flush, children }: { pending: boolean; flush?: boolean; children: ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pending ? "input" : "outcome"}
        className="card__foot"
        data-flush={(pending && flush) || undefined}
        initial={{ opacity: 0, height: 0, y: 4 }}
        animate={{ opacity: 1, height: "auto", y: 0, transition: SPRING_SOFT }}
        exit={{ opacity: 0, height: 0, scale: 0.97, transition: EXIT_FAST }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/** True once a card that mounted pending has been decided (so only fresh outcomes animate). */
function useFresh(pending: boolean): boolean {
  const mountedPending = useRef(pending);
  return mountedPending.current && !pending;
}

/** Shared head: the question in bold, optional context line under it. */
function Head({ title, detail, risk }: { title: string; detail?: string; risk?: boolean }) {
  return (
    <div className="ask__head">
      <b className="ask__title">{title}</b>
      {detail && (
        <span className="ask__detail" data-risk={risk || undefined}>
          {risk && <Icon name="shield" size={13} />}
          {detail}
        </span>
      )}
    </div>
  );
}

/** Risky effect (push, merge, delete) waiting for the owner. */
export function ApprovalCard({ m, onDecide }: { m: Approval; onDecide: Decide }) {
  const pending = m.state === "pending";
  const fresh = useFresh(pending);
  return (
    <div className="card ask" data-state={pending ? "pending" : "done"}>
      <Head title={m.title} detail={m.detail} risk />
      <Footer pending={pending} flush>
        {pending ? (
          <ConfirmBar no="Deny" yes="Approve" onDecide={onDecide} />
        ) : m.state === "expired" ? (
          <Outcome tone="bad" label={EXPIRED} fresh={false} />
        ) : (
          <Outcome tone={m.state === "Approved" ? "good" : "muted"} label={m.state} fresh={fresh} />
        )}
      </Footer>
    </div>
  );
}

/** Teammate question: yes/no, pick one, or a free-text answer. */
export function QuestionCard({ m, onDecide }: { m: Question; onDecide: Decide }) {
  const pending = m.state === "pending";
  const fresh = useFresh(pending);
  const input =
    m.ask === "yesno" ? (
      <ConfirmBar no="No" yes="Yes" onDecide={onDecide} />
    ) : m.ask === "select" ? (
      <ChoiceList id={m.id} options={m.options ?? []} onDecide={onDecide} />
    ) : (
      <TextAnswer onDecide={onDecide} />
    );
  const done =
    m.state === "expired" ? (
      <Outcome tone="bad" label={EXPIRED} fresh={false} />
    ) : m.ask === "text" ? (
      <Outcome tone="good" label="Answered" fresh={fresh}>
        <p className="answer-quote">{m.state}</p>
      </Outcome>
    ) : (
      <Outcome tone="good" label={m.ask === "yesno" ? `You said ${m.state.toLowerCase()}` : m.state} fresh={fresh} />
    );
  return (
    <div className="card ask" data-state={pending ? "pending" : "done"}>
      <Head title={m.text} detail={m.detail} />
      <Footer pending={pending} flush={m.ask !== "text"}>
        {pending ? input : done}
      </Footer>
    </div>
  );
}
