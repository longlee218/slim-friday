import { Dialog } from "@base-ui/react/dialog";
import type { ApprovalAnswer, ApprovalCardDto } from "@friday/contracts";
import { Avatar } from "../ui/avatar";
import { BottomSheet } from "../ui/bottom-sheet";
import { Button } from "../ui/button";
import { ApprovalDetail } from "./approval-detail";
import { approvalTitle } from "./approval-text";
import { countdown, useNow } from "./countdown";
import { useAnswerApproval } from "./use-answer-card";
import { useBotFace } from "./use-bot-face";

export interface ApprovalSheetProps {
  card: ApprovalCardDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Phone review sheet: the detail and full-width answers (Allow once, Always allow, Deny). */
export function ApprovalSheet({ card, open, onOpenChange }: ApprovalSheetProps) {
  const answer = useAnswerApproval();
  const now = useNow();
  const face = useBotFace(card.botId);
  const send = (a: ApprovalAnswer) =>
    answer.mutate({ card, answer: a }, { onSuccess: () => onOpenChange(false) });
  const busy = answer.isPending;
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <Avatar src={face.src} name={card.botName} size={40} />
      <Dialog.Title render={(props) => <h3 {...props}>{approvalTitle(card)}</h3>} />
      <div className="t2" style={{ margin: "0 0 8px", fontSize: 13, color: "var(--label-2)" }}>
        {countdown(card.expiresAt, now)}
      </div>
      <ApprovalDetail card={card} />
      <Button variant="primary" disabled={busy} onClick={() => send("once")}>
        Allow once
      </Button>
      {card.offerAlways && (
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
