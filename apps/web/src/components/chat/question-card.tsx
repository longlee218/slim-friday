import type { QuestionAnswerDto, QuestionCardDto } from "@friday/contracts";
import { Check, MessageCircleQuestion } from "lucide-react";
import { useRef, useState } from "react";
import type { Receipt } from "../../events/client-keys";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Pill } from "../ui/pill";
import { CardReceiptLine } from "./card-receipt-line";
import { useAnswerQuestion } from "./use-answer-card";
import { useBotFace } from "./use-bot-face";
import { useReceipt } from "./use-receipt";

/** The option of a confirm card whose label is Yes or No (any case); its value is what the server accepts. */
const confirmValue = (card: QuestionCardDto, word: "yes" | "no") =>
  card.options.find((o) => o.label.trim().toLowerCase() === word)?.value;

/** What the receipt says an answer was: option labels (and typed text), or Yes / No. */
function answerText(card: QuestionCardDto, a: QuestionAnswerDto): string {
  if (card.kind === "confirm" && a.choices.length > 0) {
    // The server stores the bot's own option value; map it back through the card, any case.
    const hit = card.options.find((o) => o.value === a.choices[0]);
    return hit?.label.trim().toLowerCase() === "no" ? "No" : "Yes";
  }
  const label = (v: string) => card.options.find((o) => o.value === v)?.label ?? v;
  return [...a.choices.map(label), ...(a.text ? [a.text] : [])].join(", ");
}

/** Receipt text of a closed question. */
function receiptText(r: Extract<Receipt, { kind: "question" }>) {
  if (r.answer === "elsewhere") return "Answered on another device";
  if (r.answer === null) return "No answer in time";
  return (
    <>
      You answered: <b style={{ color: "var(--label)" }}>{answerText(r.card, r.answer)}</b>
    </>
  );
}

/** A bot's question to the owner: single / multi choice (optional own answer) or Yes / No. */
export function QuestionCard({ card, receipt }: { card: QuestionCardDto; receipt?: Receipt }) {
  const cached = useReceipt(card.cardId);
  const done = receipt ?? cached;
  const r = done?.kind === "question" ? done : undefined;
  const answer = useAnswerQuestion();
  const face = useBotFace(card.botId);
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const multi = card.kind === "multi";
  const busy = answer.isPending;

  const pick = (value: string) =>
    setPicked((p) =>
      multi ? (p.includes(value) ? p.filter((v) => v !== value) : [...p, value]) : [value],
    );
  const pickOther = () => {
    const next = !other;
    setOther(next);
    if (!multi) setPicked([]);
    if (next) setTimeout(() => input.current?.focus(), 0);
  };
  const choose = (value: string) => {
    pick(value);
    if (!multi) setOther(false);
  };
  const yes = confirmValue(card, "yes");
  const no = confirmValue(card, "no");
  const send = () => {
    const typed = text.trim();
    answer.mutate({
      card,
      choices: picked,
      ...(other && { text: typed || "Something else" }),
    });
  };

  const optionRow = (
    value: string,
    label: string,
    description: string | undefined,
    on: boolean,
    onClick: () => void,
  ) => (
    <button
      type="button"
      key={value}
      className={`opt${multi ? " multi" : ""}${on ? " on" : ""}`}
      disabled={busy}
      onClick={onClick}
    >
      <span className="mark">
        <Check strokeWidth={1.75} />
      </span>
      <span>
        <b>{label}</b>
        {description && <span className="d">{description}</span>}
      </span>
    </button>
  );

  return (
    <div className="msg">
      <span style={{ width: 30, flex: "none" }} />
      <div className="body">
        <div className={r ? "appr ask done" : "appr ask"}>
          <div className="appr-h">
            <Avatar src={face.src} name={card.botName} size={20} />
            <span className="t">{card.question}</span>
            <Pill tone="blue">
              <MessageCircleQuestion strokeWidth={1.75} /> {card.botName} asks
            </Pill>
          </div>
          <div className="appr-body" inert={r !== undefined}>
            <div>
              <div className="appr-in" style={{ paddingTop: 10 }}>
                {card.kind === "confirm" ? (
                  <div className="appr-actions">
                    <span className="left">You can change this later in the chat.</span>
                    <Button
                      disabled={busy || no === undefined}
                      onClick={() => no !== undefined && answer.mutate({ card, choices: [no] })}
                    >
                      No
                    </Button>
                    <Button
                      variant="primary"
                      disabled={busy || yes === undefined}
                      onClick={() => yes !== undefined && answer.mutate({ card, choices: [yes] })}
                    >
                      Yes
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="opts">
                      {card.options.map((o) =>
                        optionRow(o.value, o.label, o.description, picked.includes(o.value), () =>
                          choose(o.value),
                        ),
                      )}
                      {card.allowText && (
                        <>
                          {optionRow(
                            "__other",
                            "Something else",
                            "Type your own answer",
                            other,
                            pickOther,
                          )}
                          <div className={other ? "other-in show" : "other-in"}>
                            <input
                              ref={input}
                              className="field"
                              placeholder="Your answer"
                              value={text}
                              onChange={(e) => setText(e.target.value)}
                            />
                          </div>
                        </>
                      )}
                    </div>
                    <div className="appr-actions">
                      <span className="left">{multi ? "Pick any" : "Pick one"}</span>
                      <Button
                        variant="primary"
                        disabled={busy || (picked.length === 0 && !other)}
                        onClick={send}
                      >
                        Send answer
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          <CardReceiptLine
            tone={r && (r.answer === "elsewhere" || r.answer === null) ? "neutral" : "ok"}
          >
            {r && receiptText(r)}
          </CardReceiptLine>
        </div>
      </div>
    </div>
  );
}
