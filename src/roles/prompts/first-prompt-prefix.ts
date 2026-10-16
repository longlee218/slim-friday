import type { Database } from "bun:sqlite";
import { channelDigestBlock } from "../../memory/channel-digest";
import { logEvent, logger } from "../../observability/logger";
import { rolloverSeed } from "../../session/rollover-seed";
import { channelDigest } from "../../storage/thread-store";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "first-prompt-prefix" });

/** The fields of a run input the prefix reads (a structural subset of the orchestrator's `RoleRunInput`). */
export interface FirstPromptInput {
  threadId: string;
  turnId: string;
  recent?: Parameters<typeof rolloverSeed>[3];
  channelId?: string;
  channelMode?: "task" | "chat";
}

/**
 * The one-time DATA blocks of a fresh session, as a prefix of its first user prompt: the rollover seed (thread
 * summary + last messages) first, then the channel digest (task channels only; the run input's `channelMode`, absent = task; `chat` skips it). They sit in the
 * user turn, so the transcript keeps them for every later resumed turn (a system block would be gone). The caller
 * asks only when no session lives and the call is not a resume. Empty string = nothing to add.
 */
export function firstPromptPrefix(db: Database, i: FirstPromptInput, seedAllowed: boolean): string {
  const seed = seedAllowed ? rolloverSeed(db, i.threadId, i.turnId, i.recent) : "";
  const digest =
    i.channelId && (i.channelMode ?? "task") === "task"
      ? channelDigestBlock(channelDigest(db, i.channelId, i.threadId))
      : { text: "", entries: 0 };
  if (digest.entries)
    logEvent(log, "prompt.digest", { chars: digest.text.length, entries: digest.entries });
  return [seed, digest.text].filter(Boolean).join("\n\n");
}

/** Closing line between the DATA blocks of the prefix and the owner's own text. */
export const OWNER_MESSAGE_LABEL = "Owner message:";

/**
 * The prompt of a run: the owner's text, behind the one-time prefix when there is one. Never stored anywhere else.
 * `label` false = the text already carries its own `Owner message:` line (the lead's input), so none is added.
 */
export const withPrefix = (prefix: string, text: string, label = true): string =>
  prefix ? `${prefix}\n\n${label ? `${OWNER_MESSAGE_LABEL}\n` : ""}${text}` : text;
