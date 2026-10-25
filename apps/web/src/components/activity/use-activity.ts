import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { orpc } from "../../api/client";
import { dayRange, spendDays, utcDay } from "./activity-math";

/** `Date.now()` refreshed every `ms` (session lengths tick without a refetch). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Sessions, the spend of the last `days` days and the wakes of that window. */
export function useActivity(days: 7 | 30, now: number) {
  const to = utcDay(now);
  const { from } = dayRange(to, days);
  // Window start on a day boundary so the query key stays stable between ticks.
  const since = Date.parse(`${from}T00:00:00Z`);
  const sessions = useQuery(orpc.ops.sessions.queryOptions());
  const spend = useQuery(orpc.ops.spend.queryOptions({ input: { from, to } }));
  const wakes = useQuery(orpc.ops.wakes.queryOptions({ input: { since } }));
  const chart = useMemo(() => spendDays(spend.data?.rows ?? [], to, days), [spend.data, to, days]);
  return {
    sessions: sessions.data ?? [],
    wakes: wakes.data ?? [],
    chart,
    capUsd: spend.data?.capPerBotPerDayUsd ?? 0,
  };
}
