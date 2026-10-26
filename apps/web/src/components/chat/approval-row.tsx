import type { ApprovalCardDto } from "@friday/contracts";
import { useState } from "react";
import type { Receipt } from "../../events/client-keys";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { ApprovalReceipt } from "./approval-receipt";
import { ApprovalSheet } from "./approval-sheet";
import { approvalSubtitle, approvalTitle } from "./approval-text";
import { useBotFace } from "./use-bot-face";
import { useReceipt } from "./use-receipt";

/** Phone approval: an amber row (title, the summary or scope when it adds something) with Review (opens the sheet); once answered, the receipt. */
export function ApprovalRow({ card, receipt }: { card: ApprovalCardDto; receipt?: Receipt }) {
  const [open, setOpen] = useState(false);
  const cached = useReceipt(card.cardId);
  const face = useBotFace(card.botId);
  const done = receipt ?? cached;
  if (done) return <ApprovalReceipt receipt={done} />;
  const subtitle = approvalSubtitle(card);
  return (
    <div className="ios-mini-appr">
      <Avatar src={face.src} name={card.botName} size={34} />
      <div className="grow">
        <b>{approvalTitle(card)}</b>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Review
      </Button>
      <ApprovalSheet card={card} open={open} onOpenChange={setOpen} />
    </div>
  );
}
