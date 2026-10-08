import { existsSync } from "node:fs";
import pinoRoll from "pino-roll";
import { ensureParentDir, REPO_NAME, workspacePaths } from "../config/workspace-paths";

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

/**
 * App log of the whole agent: every line goes to `logs/app.*`; a line whose `repo` field is a registered
 * workspace (a directory under workspaces/, not "*") is also written to that workspace's `logs/app.*`.
 */
export function routedStream(home: string): LogSink {
  const paths = workspacePaths(home);
  const main = rollingFile(paths.appLog());
  /** One rolling file per workspace, opened on its first line. */
  const perRepo = new Map<string, LogSink>();

  /** Sink of the line's workspace, or undefined when the line has no concrete registered repo. */
  const repoSink = (line: string): LogSink | undefined => {
    if (!line.includes('"repo":"')) return undefined; // cheap pre-check before parsing
    let repo: unknown;
    try {
      repo = JSON.parse(line).repo;
    } catch {
      return undefined;
    }
    if (typeof repo !== "string" || !REPO_NAME.test(repo)) return undefined;
    let sink = perRepo.get(repo);
    if (!sink && existsSync(paths.legacyWorkspace(repo).root /* TODO(1b) */)) {
      sink = rollingFile(paths.appLog(repo));
      perRepo.set(repo, sink);
    }
    return sink;
  };

  return {
    write(line) {
      main.write(line);
      repoSink(line)?.write(line);
    },
    ready: async () => {
      await Promise.all([main.ready(), ...[...perRepo.values()].map((s) => s.ready())]);
    },
    end() {
      main.end();
      for (const s of perRepo.values()) s.end();
    },
  };
}
