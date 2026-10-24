import pinoRoll from "pino-roll";
import { ensureParentDir } from "../config/home-paths";

/** Days of rolled log files kept besides the current one. */
const RETAIN_DAYS = 14;

/** A pino destination (`write(line)`) whose file may open asynchronously. */
export interface LogSink {
  write(line: string): void;
  /** Resolves when every file this sink uses is open and all queued lines are written. */
  ready(): Promise<void>;
  /** Close the files once open. */
  end(): void;
}

/**
 * Daily-rolled file `<base>.<yyyy-MM-dd>.<n>.jsonl`, owner-only (0600), last 14 days kept.
 * pino-roll is used as a plain stream (no worker transport: Bun). It opens asynchronously, so lines
 * written before it is open are queued and flushed in order; after that every write is synchronous.
 */
export function rollingFile(base: string): LogSink {
  ensureParentDir(base);
  let dest: { write(s: string): unknown; end(): void } | undefined;
  let queue: string[] = [];
  const opened = pinoRoll({
    file: `${base}.jsonl`, // the extension in `file` ends up last: <base>.<date>.<n>.jsonl
    frequency: "daily",
    dateFormat: "yyyy-MM-dd",
    limit: { count: RETAIN_DAYS },
    sync: true,
    mode: 0o600,
  })
    .then((d) => {
      dest = d;
      for (const line of queue) d.write(line);
      queue = [];
    })
    .catch((err) => {
      // The logger itself failed: stderr is the only place left (no console in src/).
      queue = [];
      process.stderr.write(`log file ${base} unavailable: ${String(err)}\n`);
    });
  return {
    write: (line) => (dest ? dest.write(line) : queue.push(line)),
    ready: () => opened,
    end: () => void opened.then(() => dest?.end()),
  };
}
