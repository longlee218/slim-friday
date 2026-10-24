import type { TicketStatus } from "@friday/contracts";
import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { BottomSheet } from "../ui/bottom-sheet";
import { StatusDot, StatusPill, statusName } from "./ticket-status";

/** The five statuses an owner can pick (`closed` is set only by Close ticket). */
const STATUSES: TicketStatus[] = ["todo", "doing", "blocked", "review", "done"];

/**
 * Phone status control: a button showing the current status that opens a bottom sheet with one
 * row per status (prototype `data-status-sheet`). Picking the shown status only closes the sheet.
 */
export function PhoneStatusSheet({
  value,
  onChange,
}: {
  value: TicketStatus;
  onChange: (status: TicketStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="popbtn" aria-label="Status" onClick={() => setOpen(true)}>
        <StatusPill status={value} />
        <ChevronsUpDown />
      </button>
      <BottomSheet open={open} onOpenChange={setOpen}>
        <h3>Status</h3>
        <div className="inset" style={{ margin: "8px 0" }}>
          {STATUSES.map((s) => (
            <button
              type="button"
              key={s}
              className="irow"
              onClick={() => {
                setOpen(false);
                if (s !== value) onChange(s);
              }}
            >
              <StatusDot status={s} />
              <span className="grow">{statusName(s)}</span>
              {s === value && <Check className="chev" />}
            </button>
          ))}
        </div>
      </BottomSheet>
    </>
  );
}
