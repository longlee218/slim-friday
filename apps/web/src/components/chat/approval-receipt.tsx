import { CircleCheck, CircleX } from "lucide-react";
import type { Receipt } from "../../events/client-keys";
import { scopeLine } from "./approval-text";

/** Phone receipt: a hairline line, "Allowed: GitPush" or "Denied: MergeBranch", the scope under it. */
export function ApprovalReceipt({ receipt }: { receipt: Receipt }) {
  if (receipt.kind !== "approval") return null;
  const { answer, card } = receipt;
  const deny = answer === "deny";
  const Icon = deny ? CircleX : CircleCheck;
  return (
    <div className={deny ? "ios-mini-appr done deny" : "ios-mini-appr done allow"}>
      <Icon strokeWidth={1.75} />
      <div className="grow">
        <b>
          {answer === "elsewhere"
            ? "Answered on another device"
            : `${deny ? "Denied" : "Allowed"}: ${card.tool}`}
        </b>
        <span>{scopeLine(card.scope)}</span>
      </div>
    </div>
  );
}
