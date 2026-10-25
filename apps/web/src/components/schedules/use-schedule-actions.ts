import type { ScheduleDto } from "@friday/contracts";
import { useState } from "react";
import { toast } from "sonner";
import { saveFailure } from "../settings/field-error";
import { useAppNavigate } from "../shell/use-app-navigate";
import { useRunScheduleNow, useSetScheduleEnabled } from "./use-schedules";

/** True for the API's "a run of this schedule is still going" error. */
const isConflict = (e: unknown): boolean => (e as { code?: string } | null)?.code === "CONFLICT";

/**
 * Run now of one schedule: success opens its chat; a run still going sets `busy` (the caller
 * shows "Still running" with a link to the chat) until the schedule's last run changes; any
 * other error is a toast.
 */
export function useRunNow(s: ScheduleDto) {
  const go = useAppNavigate();
  const runNow = useRunScheduleNow();
  const [busy, setBusy] = useState(false);
  // A new or finished last run ends the "Still running" note (state adjusted while rendering).
  const last = JSON.stringify(s.last ?? null);
  const [seenLast, setSeenLast] = useState(last);
  if (seenLast !== last) {
    setSeenLast(last);
    setBusy(false);
  }
  const chat = `/c/${s.conversationId}`;
  const run = () => {
    setBusy(false);
    runNow.mutate(
      { id: s.id },
      {
        onSuccess: () => go(chat),
        onError: (e) => (isConflict(e) ? setBusy(true) : toast("Could not run. Try again.")),
      },
    );
  };
  return { run, busy, pending: runNow.isPending, chat };
}

/** The on switch of one schedule: locked while saving and when its bot or group is gone. */
export function useScheduleSwitch(s: ScheduleDto) {
  const setEnabled = useSetScheduleEnabled();
  const gone = s.disabledReason === "bot_gone" || s.disabledReason === "group_gone";
  const toggle = (on: boolean) =>
    setEnabled.mutate({ id: s.id, enabled: on }, { onError: (e) => toast(saveFailure(e).message) });
  return { toggle, disabled: gone || setEnabled.isPending };
}
