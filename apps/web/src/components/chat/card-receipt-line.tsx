import { Check, CircleDashed, X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Folded receipt line of a desktop card: popping round check (red `x` for a denial, dashed grey circle when nobody answered here),
 * the text and a right-aligned "just now". Its height animates in from the `.done` class.
 */
export function CardReceiptLine({
  tone = "ok",
  children,
}: {
  tone?: "ok" | "deny" | "neutral";
  children?: ReactNode;
}) {
  return (
    <div className="appr-receipt">
      {children !== undefined && (
        <>
          <span className={tone === "ok" ? "ok" : `ok ${tone}`}>
            {tone === "deny" ? (
              <X strokeWidth={1.75} />
            ) : tone === "neutral" ? (
              <CircleDashed strokeWidth={1.75} />
            ) : (
              <Check strokeWidth={1.75} />
            )}
          </span>
          <span>{children}</span>
          <span style={{ marginLeft: "auto" }}>just now</span>
        </>
      )}
    </div>
  );
}
