import { Dialog } from "@base-ui/react/dialog";
import type { ApprovalAnswer, ApprovalCardDto } from "@friday/contracts";
import { Avatar } from "../ui/avatar";
import { BottomSheet } from "../ui/bottom-sheet";
import { Button } from "../ui/button";
import { ApprovalDetail } from "./approval-detail";
import { approvalTitle } from "./approval-text";
import { useAnswerApproval } from "./use-answer-card";
import { useBotFace } from "./use-bot-face";

export interface ApprovalSheetProps {
  card: ApprovalCardDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Phone review sheet: the detail and full-width answers (Allow once, Always allow, Deny; only Deny when the input is cut). */
export function ApprovalSheet({ card, open, onOpenChange }: ApprovalSheetProps) {
  const answer = useAnswerApproval();
  const face = useBotFace(card.botId);
  const send = (a: ApprovalAnswer) =>
    answer.mutate({ card, answer: a }, { onSuccess: () => onOpenChange(false) });
  const busy = answer.isPending;
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      {/* Face beside the title, as the prototype's review sheet (durable cards have no countdown). */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <Avatar src={face.src} name={card.botName} size={40} />
        <Dialog.Title render={(props) => <h3 {...props}>{approvalTitle(card)}</h3>} />
      </div>
      <ApprovalDetail card={card} />
      {!card.inputCut && (
        <Button variant="primary" disabled={busy} onClick={() => send("once")}>
          Allow once
        </Button>
      )}
      {card.offerAlways && !card.inputCut && (
        <Button disabled={busy} onClick={() => send("always")}>
          Always allow
        </Button>
      )}
      <Button variant="danger" disabled={busy} onClick={() => send("deny")}>
        Deny
      </Button>
    </BottomSheet>
  );
}
