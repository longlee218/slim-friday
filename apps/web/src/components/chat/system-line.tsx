import type { MessageDto } from "@friday/contracts";
import { Info } from "lucide-react";
import { formatClock } from "../../lib/format";
import { TicketText } from "./ticket-text";

/** A centred system note ("Dev joined ..."), ticket refs linked. */
export function SystemLine({ message }: { message: MessageDto }) {
  return (
    <div className="sys">
      <Info strokeWidth={1.75} />
      <span>
        <TicketText text={message.text} />
      </span>
    </div>
  );
}

/** A day separator: "Today", "Yesterday", else the short date `formatClock` gives. */
export function DayLine({ at }: { at: number }) {
  const label = formatClock(at, Date.now());
  // Within today `formatClock` returns a clock time; the separator wants the word.
  return <div className="day">{/^\d\d:\d\d$/.test(label) ? "Today" : label}</div>;
}
