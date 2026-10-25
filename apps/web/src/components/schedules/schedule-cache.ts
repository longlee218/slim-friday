import type { QueryClient } from "@tanstack/react-query";
import { orpc } from "../../api/client";

/**
 * Refetches every schedules query (list, one schedule, its runs). Used by each mutation and by
 * the `schedule` live event, so a schedule a bot creates or changes shows without a reload.
 */
export function invalidateSchedules(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: orpc.schedules.key() });
}
