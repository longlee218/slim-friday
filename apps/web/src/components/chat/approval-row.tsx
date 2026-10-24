import type { ApprovalCardDto } from "@friday/contracts";
import { useState } from "react";
import type { Receipt } from "../../events/client-keys";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { ApprovalReceipt } from "./approval-receipt";
import { ApprovalSheet } from "./approval-sheet";
import { approvalTitle } from "./approval-text";
import { countdown, useNow } from "./countdown";
import { useBotFace } from "./use-bot-face";
import { useReceipt } from "./use-receipt";

/** Phone approval: an amber row with Review (opens the sheet); once answered, the receipt. */
export function ApprovalRow({ card, receipt }: { card: ApprovalCardDto; receipt?: Receipt }) {
  const [open, setOpen] = useState(false);
  const cached = useReceipt(card.cardId);
  const now = useNow();
  const face = useBotFace(card.botId);
  const done = receipt ?? cached;
  if (done) return <ApprovalReceipt receipt={done} />;
  const left = countdown(card.expiresAt, now);
  return (
    <div className="ios-mini-appr">
      <Avatar src={face.src} name={card.botName} size={34} />
      <div className="grow">
        <b>{approvalTitle(card)}</b>
        <span>{left ? `${card.tool} · ${left}` : card.tool}</span>
      </div>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Review
      </Button>
      <ApprovalSheet card={card} open={open} onOpenChange={setOpen} />
    </div>
  );
}
