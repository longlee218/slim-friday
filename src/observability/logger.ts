import { clip, errText, redactText } from "@friday/tools";
import pino, { type DestinationStream, type Logger } from "pino";
import pretty, { type PrettyOptions } from "pino-pretty";
import { ensureParentDir, homePaths } from "../config/home-paths";
import { readProcessEnv } from "../config/process-env";
import { axiomStreamFrom } from "./axiom-stream";
import { CONSOLE_IGNORE, consoleMessage } from "./console-format";
import { rollingFile } from "./log-files";

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
  "apiKey",
  "ANTHROPIC_AUTH_TOKEN",
  "*.ANTHROPIC_AUTH_TOKEN",
  "AXIOM_TOKEN",
  "*.AXIOM_TOKEN",
];

/** Sync file destination (no worker transport: avoids Bun worker risk). */
export function fileDestination(file: string) {
  return pino.destination({ dest: ensureParentDir(file), sync: true, mode: 0o600 });
}

/**
 * Build a pino logger writing to a stream with standard redaction.
 */
export function createLogger(stream: DestinationStream, level = "info"): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream);
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

/** pino-pretty options of the terminal stream (in-process, so `messageFormat` may be a function). */
export function consolePrettyOptions(): PrettyOptions {
  return {
    colorize: true,
    sync: true,
    singleLine: true,
    translateTime: "SYS:HH:MM:ss",
    messageFormat: (log) => consoleMessage(log as Record<string, unknown>),
    ignore: CONSOLE_IGNORE.join(","),
  };
}

/** Axiom stream when AXIOM_TOKEN and AXIOM_DATASET are set (events only, allow-listed fields). */
const axiom = axiomStreamFrom(readProcessEnv().AXIOM_TOKEN?.trim(), readProcessEnv().AXIOM_DATASET);

/** Send buffered events to Axiom; call at shutdown. No-op when Axiom is off. */
export const flushAxiom = (): Promise<void> => axiom?.flush() ?? Promise.resolve();

/** Pick the destination: rolled files under AGENT_HOME (+ pretty stdout in dev); stdout JSON otherwise. */
async function buildSharedLogger(): Promise<Logger> {
  const level = readProcessEnv().LOG_LEVEL ?? "info";
  const home = readProcessEnv().AGENT_HOME;
  // Under `bun test` (NODE_ENV=test) never write to a file or stderr: lines only reach `captureLogs`.
  if (readProcessEnv().NODE_ENV === "test")
    return createLogger(
      {
        write: (line: string) => {
          for (const sink of testSinks) sink(line);
        },
      },
      "debug",
    );
  // Also print to the terminal when run interactively (a TTY) or in dev; background runs (nohup) stay file-only.
  const toTerminal = process.stdout.isTTY === true || readProcessEnv().NODE_ENV === "development";
  if (!home) return createLogger(pino.destination({ fd: 2, sync: true }), level);
  const file = rollingFile(homePaths(home).appLog());
  // Open the main file before the first line so early/fatal lines are written synchronously.
  await file.ready();
  /** The file, plus Axiom when on. */
  const streams = [{ stream: file }, ...(axiom ? [{ stream: axiom }] : [])];
  if (!toTerminal) return createLogger(pino.multistream(streams), level);
  // One short line per event (see console-format.ts); the file keeps every field.
  const stdout = pretty(consolePrettyOptions());
  return createLogger(pino.multistream([...streams, { stream: stdout }]), level);
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
