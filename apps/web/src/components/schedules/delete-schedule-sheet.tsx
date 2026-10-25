import type { ScheduleDto } from "@friday/contracts";
import { toast } from "sonner";
import { saveFailure } from "../settings/field-error";
import { useAppNavigate } from "../shell/use-app-navigate";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import { useDeleteSchedule } from "./use-schedules";

/**
 * The confirm of Delete (prototype `deleteScheduleSheet`): the schedule and its run history
 * go; the messages it posted stay in the chat. Success returns to the list.
 */
export function DeleteScheduleSheet({
  schedule: s,
  open,
  onOpenChange,
}: {
  schedule: ScheduleDto;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const del = useDeleteSchedule();
  const go = useAppNavigate();
  const remove = () =>
    del.mutate(
      { id: s.id },
      {
        onSuccess: () => {
          toast(`${s.name} deleted.`);
          go("/schedules");
        },
        onError: (e) => toast.error(saveFailure(e).message),
      },
    );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <h3>Delete {s.name}?</h3>
      <p style={{ color: "var(--label-2)", margin: "6px 0 14px" }}>
        Its run history goes too. Messages it posted stay in the chat.
      </p>
      <div className="acts">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="danger" disabled={del.isPending} onClick={remove}>
          Delete schedule
        </Button>
      </div>
    </Sheet>
  );
}
