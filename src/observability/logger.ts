import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type DestinationStream, type Logger } from "pino";
import pretty from "pino-pretty";
import { ensureParentDir } from "../config/workspace-paths";
import { routedStream } from "./log-files";
import { clip, errText, redactText } from "./redact";

/** Key paths pino censors before serialization (layer 1; free text uses redact.ts). */
const REDACT_PATHS = [
  "token",
  "authorization",
  "password",
  "*.token",
  "*.apiKey",
  "*.authorization",
  "env.*",
  "*.env.*",
  "oauthToken",
  "*.oauthToken",
  "openrouterApiKey",
  "*.openrouterApiKey",
  "apiKey",
  "OPENROUTER_API_KEY",
  "*.OPENROUTER_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "*.ANTHROPIC_AUTH_TOKEN",
];

/** Sync file destination (no worker transport: avoids Bun worker risk). */
export function fileDestination(file: string) {
  return pino.destination({ dest: ensureParentDir(file), sync: true, mode: 0o600 });
}

/** Correlation fields of the task the current code runs in; merged into every log line. */
export interface LogContext {
  taskId?: string;
  threadId?: string;
  /** Workspace of the task ("*" = not chosen yet); also routes the line to that workspace's log. */
  repo?: string;
  /** "qa" | "plan" | "exec". */
  mode?: string;
}

/** Holds the mutable context object of the current async call tree (follows awaits, timers, callbacks). */
const contextStore = new AsyncLocalStorage<LogContext>();

/** Run `fn` with `ctx` merged over the parent context; everything it awaits or schedules inherits it. */
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return contextStore.run({ ...contextStore.getStore(), ...ctx }, fn);
}

/** Add or change fields of the current context (e.g. repo once chosen). No-op outside a context. */
export function setLogContext(fields: LogContext): void {
  const ctx = contextStore.getStore();
  if (ctx) Object.assign(ctx, fields);
}

/** Copy of the current context ({} outside one). */
export function getLogContext(): LogContext {
  return { ...contextStore.getStore() };
}

/**
 * Build a pino logger writing to a stream with standard redaction. The mixin adds the current log
 * context to every line; pino lets the fields of the call win over the mixin's, and the copy keeps
 * pino from writing those back into the shared context object.
 */
export function createLogger(stream: DestinationStream, level = "info"): Logger {
  return pino(
    { level, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" }, mixin: getLogContext },
    stream,
  );
}

/** Test hook: receivers of every line the shared logger writes under `bun test` (else it drops them). */
const testSinks = new Set<(line: string) => void>();

/** Test helper: parsed lines of the shared logger (all modules) until `stop()`. */
export function captureLogs(): { lines: Record<string, unknown>[]; stop(): void } {
  const lines: Record<string, unknown>[] = [];
  const sink = (line: string) => void lines.push(JSON.parse(line));
  testSinks.add(sink);
  return { lines, stop: () => void testSinks.delete(sink) };
}

/** Pick the destination: rolled files under AGENT_HOME (+ pretty stdout in dev); stdout JSON otherwise. */
async function buildSharedLogger(): Promise<Logger> {
  const level = process.env.LOG_LEVEL ?? "info";
  const home = process.env.AGENT_HOME;
  // Under `bun test` (NODE_ENV=test) never write to a file or stderr: lines only reach `captureLogs`.
  if (process.env.NODE_ENV === "test")
    return createLogger(
      {
        write: (line: string) => {
          for (const sink of testSinks) sink(line);
        },
      },
      "debug",
    );
  // Also print to the terminal when run interactively (a TTY) or in dev; background runs (nohup) stay file-only.
  const toTerminal = process.stdout.isTTY === true || process.env.NODE_ENV === "development";
  if (!home) return createLogger(pino.destination({ fd: 2, sync: true }), level);
  const file = routedStream(home);
  // Open the main file before the first line so early/fatal lines are written synchronously.
  await file.ready();
  if (!toTerminal) return createLogger(file, level);
  // One readable line per event: time, level, message/event and its fields.
  const stdout = pretty({
    colorize: true,
    sync: true,
    singleLine: true,
    translateTime: "SYS:HH:MM:ss",
    ignore: "pid,hostname",
  });
  return createLogger(pino.multistream([{ stream: file }, { stream: stdout }]), level);
}

/** The one shared logger. Use `logger.child({ module })`; task fields come from the log context. */
export const logger: Logger = await buildSharedLogger();

/** Run `fn` and never throw: a failure is logged (redacted) as `what`. For best-effort side work. */
export function tryLog(log: Logger, what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.error({ err: errText(err) }, what);
  }
}

/** Max chars of user/answer text in a log line. */
const EXCERPT_MAX = 500;

/** Text safe for a log line: secrets masked, whitespace collapsed, capped. */
export function excerpt(text: string, max = EXCERPT_MAX): string {
  return clip(redactText(text).replace(/\s+/g, " ").trim(), max);
}

/**
 * Log one lifecycle event: a stable `event` field (also the message) plus correlation/detail fields.
 * taskId/threadId/repo/mode come from the log context (see `runWithLogContext`), not from the caller.
 * Callers pass free text through `excerpt()` and errors through `errText()`.
 */
export function logEvent(
  log: Logger,
  event: string,
  fields: Record<string, unknown> = {},
  level: "debug" | "info" | "warn" | "error" = "info",
): void {
  log[level]({ event, ...fields }, event);
}
