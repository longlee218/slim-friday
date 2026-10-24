import type { Log } from "../../src";

/** A Log that keeps every line for the test to read. */
export class FakeLog implements Log {
  lines: { level: "info" | "warn" | "error"; fields: Record<string, unknown>; msg: string }[] = [];
  info = (o: object, msg: string) => void this.lines.push({ level: "info", fields: { ...o }, msg });
  warn = (o: object, msg: string) => void this.lines.push({ level: "warn", fields: { ...o }, msg });
  error = (o: object, msg: string) =>
    void this.lines.push({ level: "error", fields: { ...o }, msg });

  /** Lines whose message is `msg`. */
  of(msg: string) {
    return this.lines.filter((l) => l.msg === msg);
  }
}
