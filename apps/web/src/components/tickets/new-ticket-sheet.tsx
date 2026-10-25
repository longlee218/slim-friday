import type { TicketDto, TicketPriority } from "@friday/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { client } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { useIsPhone } from "../../app/use-is-phone";
import { Group } from "../settings/form-parts";
import { BottomSheet } from "../ui/bottom-sheet";
import { Sheet } from "../ui/sheet";
import { SheetForm } from "../ui/sheet-bar";
import { patchTicket } from "./ticket-cache";
import { AssigneeSelect, PrioritySelect } from "./ticket-fields";

export interface NewTicketSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new ticket after the sheet closed (the app opens it on the board). */
  onCreated?: (ticket: TicketDto) => void;
}

/** The fields and buttons; mounted only while the sheet is open, so every opening starts blank. */
function NewTicketForm({ onOpenChange, onCreated }: Omit<NewTicketSheetProps, "open">) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const create = useMutation({
    mutationFn: () =>
      client.tickets.create({
        title: title.trim(),
        ...(details.trim() && { description: details.trim() }),
        ...(assignee && { assignee }),
        priority,
      }),
    onSuccess: (ticket) => {
      patchTicket(qc, ticket);
      toast.success("Ticket created.");
      onOpenChange(false);
      onCreated?.(ticket);
    },
    onError: () => toast("Could not create the ticket. Try again."),
  });
  const canCreate = title.trim() !== "" && !create.isPending;
  const submit = () => {
    if (canCreate) create.mutate();
  };

  return (
    <SheetForm
      title="New ticket"
      onCancel={() => onOpenChange(false)}
      onSubmit={submit}
      action={
        <button
          type="submit"
          className="nb strong"
          disabled={!canCreate}
          aria-label="Create ticket"
        >
          {create.isPending ? "Creating…" : "Create"}
        </button>
      }
    >
      <Group>
        <div className="frow">
          <label htmlFor="nt-title">Title</label>
          <div className="ctl">
            <input
              id="nt-title"
              className="field"
              placeholder="What needs doing"
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </div>
      </Group>
      <Group title={<label htmlFor="nt-details">Details</label>} wide>
        <textarea
          id="nt-details"
          className="field"
          rows={4}
          placeholder="Optional"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
        />
      </Group>
      <Group foot={assignee && `Assigning wakes ${dir.botName(assignee)} with this ticket.`}>
        <div className="frow">
          <span>Assignee</span>
          <div className="ctl">
            <AssigneeSelect value={assignee} onChange={setAssignee} />
          </div>
        </div>
        <div className="frow">
          <span>Priority</span>
          <div className="ctl">
            <PrioritySelect value={priority} onChange={setPriority} />
          </div>
        </div>
      </Group>
    </SheetForm>
  );
}

/** New-ticket sheet: a centred glass sheet on desktop, rises from the bottom on the phone. */
export function NewTicketSheet(props: NewTicketSheetProps) {
  const phone = useIsPhone();
  const form = <NewTicketForm onOpenChange={props.onOpenChange} onCreated={props.onCreated} />;
  return phone ? (
    <BottomSheet open={props.open} onOpenChange={props.onOpenChange}>
      {form}
    </BottomSheet>
  ) : (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      {form}
    </Sheet>
  );
}
