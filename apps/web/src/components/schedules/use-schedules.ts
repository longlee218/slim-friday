import type { ScheduleDto } from "@friday/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../../api/client";
import { invalidateSchedules } from "./schedule-cache";

/** Every schedule, as served; `loaded` is false until the list has arrived (or after it failed). */
export function useSchedules(): { schedules: ScheduleDto[]; isLoading: boolean; loaded: boolean } {
  const q = useQuery(orpc.schedules.list.queryOptions({ input: {} }));
  return { schedules: q.data?.items ?? [], isLoading: q.isLoading, loaded: q.data !== undefined };
}

/** Schedules that are on (the sidebar badge and the page subtitle). */
export const enabledCount = (ss: ScheduleDto[]): number => ss.filter((s) => s.enabled).length;

/** One schedule by id. */
export function useSchedule(id: string) {
  return useQuery(orpc.schedules.get.queryOptions({ input: { id } }));
}

/** Run history of a schedule, newest first; the next page starts at `nextBefore`. */
export function useScheduleRuns(id: string) {
  return useInfiniteQuery(
    orpc.schedules.runs.infiniteOptions({
      input: (before: number | undefined) => ({ id, before }),
      initialPageParam: undefined,
      getNextPageParam: (p: { nextBefore?: number }) => p.nextBefore,
    }),
  );
}

type Create = Parameters<typeof client.schedules.create>[0];
type Update = Parameters<typeof client.schedules.update>[0];

/** Runs a client call, then refetches the schedules queries (every mutation here does this). */
function useScheduleMutation<I, O>(fn: (input: I) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation<O, Error, I>({
    mutationFn: fn,
    onSuccess: () => invalidateSchedules(qc),
  });
}

/** Creates a schedule. */
export const useCreateSchedule = () =>
  useScheduleMutation((input: Create) => client.schedules.create(input));

/** Edits name, task, repeat rule or notify mode. */
export const useUpdateSchedule = () =>
  useScheduleMutation((input: Update) => client.schedules.update(input));

/** Turns a schedule on or off. */
export const useSetScheduleEnabled = () =>
  useScheduleMutation((input: { id: string; enabled: boolean }) =>
    client.schedules.setEnabled(input),
  );

/** Runs a schedule now; a fresh nonce per press makes a double click one run. */
export const useRunScheduleNow = () =>
  useScheduleMutation((input: { id: string }) =>
    client.schedules.runNow({ id: input.id, nonce: crypto.randomUUID() }),
  );

/** Deletes a schedule (past results stay in the chat). */
export const useDeleteSchedule = () =>
  useScheduleMutation((input: { id: string }) => client.schedules.delete(input));
