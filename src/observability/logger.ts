import pino, { type DestinationStream, type Logger } from "pino";
import pretty from "pino-pretty";
import { ensureParentDir, workspacePaths } from "../workspace/workspace-paths";

/** Key paths pino censors before serialization (layer 1; free text uses redact.ts). */
export const REDACT_PATHS = [
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

/** Build a pino logger writing to a stream with standard redaction. */
export function createLogger(stream: DestinationStream, level = "info"): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream);
}

/** Pick the destination: file under AGENT_HOME (+ pretty stdout in dev); stdout JSON otherwise. */
function buildSharedLogger(): Logger {
  const level = process.env.LOG_LEVEL ?? "info";
  const home = process.env.AGENT_HOME;
  // Under `bun test` (NODE_ENV=test) stay silent so tests never write into a real AGENT_HOME.
  if (process.env.NODE_ENV === "test")
    return createLogger(pino.destination({ fd: 2, sync: true }), "silent");
  const isDev = process.env.NODE_ENV === "development";
  if (!home) return createLogger(pino.destination({ fd: 2, sync: true }), level);
  const file = fileDestination(workspacePaths(home).appLog);
  if (!isDev) return createLogger(file, level);
  const stdout = pretty({ colorize: true, sync: true });
  return createLogger(pino.multistream([{ stream: file }, { stream: stdout }]), level);
}

/** The one shared logger. Use `logger.child({ module, taskId, threadId })`. */
export const logger: Logger = buildSharedLogger();
