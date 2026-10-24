import { Check, X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Folded receipt line of a desktop card: popping round check (red `x` for a denial),
 * the text and a right-aligned "just now". Its height animates in from the `.done` class.
 */
export function CardReceiptLine({ deny, children }: { deny?: boolean; children?: ReactNode }) {
  return (
    <div className="appr-receipt">
      {children !== undefined && (
        <>
          <span className={deny ? "ok deny" : "ok"}>
            {deny ? <X strokeWidth={1.75} /> : <Check strokeWidth={1.75} />}
          </span>
          <span>{children}</span>
          <span style={{ marginLeft: "auto" }}>just now</span>
        </>
      )}
    </div>
  );
}
