import type { ScheduleDto } from "@friday/contracts";
import { toast } from "sonner";
import { useIsPhone } from "../../app/use-is-phone";
import { usePhoneStack } from "../phone/phone-shell";
import { saveFailure } from "../settings/field-error";
import { useAppNavigate } from "../shell/use-app-navigate";
import { BottomSheet } from "../ui/bottom-sheet";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import { useDeleteSchedule } from "./use-schedules";

/**
 * The confirm of Delete (prototype `deleteScheduleSheet`): the schedule and its run history
 * go; the messages it posted stay in the chat. Success returns to the list without leaving the
 * deleted page in history: on the phone it pops back when the list is underneath, else it
 * replaces the page. A bottom sheet on the phone, like the other sheets there.
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
  const { stack, back } = usePhoneStack();
  const Shell = useIsPhone() ? BottomSheet : Sheet;
  const remove = () =>
    del.mutate(
      { id: s.id },
      {
        onSuccess: () => {
          toast(`${s.name} deleted.`);
          if (stack.at(-2) === "/schedules") back();
          else go("/schedules", { replace: true });
        },
        onError: (e) => toast.error(saveFailure(e).message),
      },
    );
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
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
    </Shell>
  );
}
