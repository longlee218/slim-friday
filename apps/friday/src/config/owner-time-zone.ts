/**
 * The owner's time zone for the turns: the `settings.yaml` `owner.timeZone` when set, else the machine's zone,
 * else UTC (a runtime that reports none).
 */
export function resolveOwnerTimeZone(configured?: string): string {
  return configured ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
}
