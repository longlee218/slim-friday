/** Minimal structured logger the api needs; the app passes its pino logger. */
export interface ApiLog {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
  error(o: object, msg: string): void;
}

/** Write one `{ event, ...fields }` line with `event` as the message (metadata only, never bodies or tokens). */
export function logApiEvent(
  log: ApiLog,
  event: string,
  fields: Record<string, unknown> = {},
  level: "info" | "warn" | "error" = "info",
): void {
  log[level]({ event, ...fields }, event);
}
