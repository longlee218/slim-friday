import type { ApprovalAnswer, ApprovalCardDto } from "@friday/contracts";
import { Hand } from "lucide-react";
import type { Receipt } from "../../events/client-keys";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Pill } from "../ui/pill";
import { ApprovalDetail } from "./approval-detail";
import { APPROVAL_VERB, alwaysLabel, approvalTitle, scopeLine, toolLabel } from "./approval-text";
import { CardReceiptLine } from "./card-receipt-line";
import { useAnswerApproval } from "./use-answer-card";
import { useBotFace } from "./use-bot-face";
import { useReceipt } from "./use-receipt";

/**
 * Desktop approval card, inline in the transcript (never a modal). Answering folds the body
 * into a receipt line. `receipt` forces the folded state; otherwise it follows the receipts cache.
 */
export function ApprovalCard({ card, receipt }: { card: ApprovalCardDto; receipt?: Receipt }) {
  const cached = useReceipt(card.cardId);
  const done = receipt ?? cached;
  const answer = useAnswerApproval();
  const face = useBotFace(card.botId);
  const send = (a: ApprovalAnswer) => answer.mutate({ card, answer: a });
  const busy = answer.isPending;
  const r = done?.kind === "approval" ? done : undefined;

  return (
    <div className="msg">
      <span style={{ width: 30, flex: "none" }} />
      <div className="body">
        <div className={r ? "appr done" : "appr"}>
          <div className="appr-h">
            <Avatar src={face.src} name={card.botName} size={20} />
            <span className="t">{approvalTitle(card)}</span>
            <Pill tone="amber">
              <Hand strokeWidth={1.75} /> Waiting for you
            </Pill>
          </div>
          <div className="appr-body" inert={r !== undefined}>
            <div>
              <div className="appr-in">
                <ApprovalDetail card={card} />
                <div className="appr-actions">
                  <span className="left" />
                  <Button disabled={busy} onClick={() => send("deny")}>
                    Deny
                  </Button>
                  {card.offerAlways && !card.inputCut && (
                    <Button disabled={busy} onClick={() => send("always")}>
                      {alwaysLabel(card)}
                    </Button>
                  )}
                  {!card.inputCut && (
                    <Button variant="primary" disabled={busy} onClick={() => send("once")}>
                      Allow once
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
          <CardReceiptLine
            tone={
              r?.answer === "deny"
                ? "deny"
                : r?.answer === "elsewhere" || r?.answer === null
                  ? "neutral"
                  : "ok"
            }
          >
            {r &&
              (r.answer === "elsewhere" ? (
                "Answered on another device"
              ) : r.answer === null ? (
                "Withdrawn by the bot"
              ) : (
                <>
                  {APPROVAL_VERB[r.answer]}:{" "}
                  <b style={{ color: "var(--label)" }}>{toolLabel(r.card.tool)}</b>{" "}
                  {scopeLine(r.card.scope)}
                </>
              ))}
          </CardReceiptLine>
        </div>
      </div>
    </div>
  );
}
