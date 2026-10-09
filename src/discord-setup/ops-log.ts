import type { Client } from "discord.js";
import { SAFE_MENTIONS } from "../ingress/discord-message-rules";
import { logger } from "../observability/logger";
import { errText, redactText } from "../observability/redact";

const log = logger.child({ module: "ops-log" });

/** Max chars of the free-text part of an #ops-log line. */
const LINE_MAX = 200;
/** Max wait for the post; a stuck gateway must never block shutdown. */
const POST_TIMEOUT_MS = 3000;

/** One #ops-log line: a fixed prefix plus redacted, clipped detail. Pure. */
export function opsLogLine(event: "start" | "shutdown" | "error", detail: unknown): string {
  const text =
    typeof detail === "string"
      ? redactText(detail).slice(0, LINE_MAX)
      : safeErr(detail).slice(0, LINE_MAX);
  return `[${event}] ${text}`;
}

/** Best-effort poster to the #ops-log channel. */
export interface OpsLog {
  post(event: "start" | "shutdown" | "error", detail: unknown): Promise<void>;
}

/** Identical `error` lines within this window are posted once. */
const DEDUP_MS = 60_000;
/** Max `error` lines per minute (an error burst must not spam the channel). */
const MAX_ERRORS_PER_MINUTE = 5;

/**
 * Build the #ops-log poster. With no channel id (discord.yaml has no ops.log) every post is a no-op. A
 * failure (including a hostile error value) is logged locally and swallowed: it never blocks start or stop
 * and never posts to #ops-log again (no loop). `error` lines are deduplicated and rate limited.
 */
export function createOpsLog(
  getClient: () => Client | undefined,
  channelId?: string,
  now: () => number = Date.now,
): OpsLog {
  const lastSeen = new Map<string, number>();
  let errorTimes: number[] = [];
  return {
    async post(event, detail) {
      if (!channelId) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const line = opsLogLine(event, detail);
        if (event === "error") {
          const t = now();
          errorTimes = errorTimes.filter((x) => t - x < DEDUP_MS);
          if (
            (lastSeen.get(line) ?? -DEDUP_MS) + DEDUP_MS > t ||
            errorTimes.length >= MAX_ERRORS_PER_MINUTE
          )
            return;
          lastSeen.set(line, t);
          errorTimes.push(t);
        }
        const send = async () => {
          const ch = await getClient()?.channels.fetch(channelId);
          if (ch?.isSendable()) await ch.send({ content: line, allowedMentions: SAFE_MENTIONS });
        };
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("ops-log post timed out")), POST_TIMEOUT_MS);
        });
        await Promise.race([send(), timeout]);
      } catch (err) {
        log.warn({ err: safeErr(err), event }, "ops-log post failed");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Error text that cannot throw itself (e.g. a null-prototype rejection reason). */
function safeErr(err: unknown): string {
  try {
    return errText(err);
  } catch {
    return "unprintable error";
  }
}
