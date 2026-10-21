import { francAll } from "franc-min";
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  type OwnerLanguage,
  SOURCE_LANGUAGE,
} from "../i18n/languages";
import type { RecentMessage } from "./intent-types";
import { isPlanNotice, renderPlanNotice } from "./notice-text-plan";
import { renderRunNotice } from "./notice-text-run";
import { isUiNotice, renderUiNotice } from "./notice-text-ui";

/** The conversation languages (list: `i18n/languages.ts`), re-exported for the ingress modules. */
export type { OwnerLanguage };

/** Verified application facts; exceptions, IDs and raw request briefs are deliberately absent. */
export type UserNotice =
  | { kind: "start" }
  | { kind: "steer"; state: "queued" | "held" | "waiting" | "full" | "ended" | "resumed" }
  | { kind: "queue"; full?: boolean }
  | { kind: "clarification"; pending?: boolean }
  | { kind: "stop"; active: boolean }
  | { kind: "replacement" }
  | { kind: "outcome"; outcome: string; resetsAt?: number }
  | {
      kind: "failure";
      cause?: "busy" | "budget" | "location" | "approval" | "expired" | "drain" | "ceiling";
      /** Valid location names, listed back to the owner for `cause: "location"` (names are not secrets). */
      names?: string[];
    }
  | {
      kind: "note";
      state:
        | "no-delivery"
        | "empty-text"
        | "stop-in-thread"
        | "status-in-thread"
        | "not-allowed"
        | "channel-unavailable";
    }
  | { kind: "ask-after-location"; name?: string }
  /** The owner clicked Approve and the plan could not start (no ids: only the cause class). */
  | { kind: "plan-not-started"; cause: "closed" | "budget" | "other" }
  /** Before a PLAN goal is replaced by a new goal (its plan and running work are cancelled): the owner's yes/no. */
  | { kind: "plan-supersede-ask"; intent?: string }
  /** An applied plan revision, version `from` to `to` (item keys, never ids). */
  | {
      kind: "plan-revised";
      from: number;
      to: number;
      cancelled: string[];
      added: string[];
      modified: string[];
      criteriaChanged: boolean;
    }
  /** An owner-made channel was just mapped to a space (auto-adopt). */
  | { kind: "channel-adopted"; space: string; name: string }
  /** Auto-adopt refused: the channel is not private, two spaces claim its category, or it could not be written. */
  | { kind: "channel-adopt-refused"; reason: "not-private" | "ambiguous" | "name-taken" | "failed" }
  | {
      kind: "approval";
      state:
        | "approve"
        | "deny"
        | "owner-only"
        | "expired"
        | "timeout"
        | "cancelled"
        | "enter"
        | "modal-title"
        | "placeholder"
        | "full-text"
        | "options-in-file";
    }
  | { kind: "choice"; state: "chose" | "answered"; text: string }
  /** Short labels and gate questions; never matched back by text (a bare "No" must not be replaced). */
  | {
      kind: "label";
      state: "yes-run" | "no" | "reply-attached" | "full-result";
    }
  | {
      kind: "decision";
      state: "confirm" | "gate" | "none" | "dropped" | "decline-busy";
    };

/** Digits, yes/no and slash commands say nothing about the language: they inherit the conversation's. */
const NEUTRAL = /^(?:\d+|yes|no|ok|okay|go|stop|\/go(?: \+\d+(?:\.\d+)?)?|\/stop)[.!?]*$/i;
/** The detector must beat the other language by this much, else the text is treated as undecided. */
const DETECT_MARGIN = 0.3;

/** The listed languages as [code, franc code, script marks?] rows. */
const ENTRIES = Object.entries(LANGUAGES) as [OwnerLanguage, { franc: string; marks?: RegExp }][];

/** Detect one of the listed languages from one text with franc (script marks first); undefined when neutral, too short or ambiguous. */
export function detectLanguage(value: string): OwnerLanguage | undefined {
  const text = value.trim();
  if (NEUTRAL.test(text)) return;
  const marked = ENTRIES.find(([, l]) => l.marks?.test(text));
  if (marked) return marked[0];
  const [top, second] = francAll(text, { only: ENTRIES.map(([, l]) => l.franc), minLength: 3 });
  if (!top || top[0] === "und" || (second && top[1] - second[1] < DETECT_MARGIN)) return;
  return ENTRIES.find(([, l]) => l.franc === top[0])?.[0];
}

/**
 * Conversation language of the owner's text. Neutral or ambiguous text inherits the latest recognizable OWNER
 * message of `recent` (bot messages never count); with none, the default language.
 */
export function languageOf(text: string, recent: RecentMessage[] = []): OwnerLanguage {
  return (
    detectLanguage(text) ??
    [...recent]
      .reverse()
      .filter((m) => m.from === "owner")
      .map((m) => detectLanguage(m.text))
      .find(Boolean) ??
    DEFAULT_LANGUAGE
  );
}

/** Ingress can pin the language once; non-Discord callers use the same fallback. */
export function messageLanguage(message: {
  text: string;
  recent?: RecentMessage[];
  language?: OwnerLanguage;
}): OwnerLanguage {
  return message.language ?? languageOf(message.text, message.recent);
}

/** Threads whose language ingress pinned; bounded (oldest dropped) so a long-lived bot does not grow it forever. */
const PINNED_MAX = 500;
const pinned = new Map<string, OwnerLanguage>();

/** Record the language ingress decided for a thread: the one source buttons, selects and notices read. */
export function pinThreadLanguage(threadId: string, language: OwnerLanguage): void {
  pinned.delete(threadId); // re-insert so the most recently used threads survive the cap
  pinned.set(threadId, language);
  if (pinned.size > PINNED_MAX) {
    const oldest = pinned.keys().next();
    if (!oldest.done) pinned.delete(oldest.value);
  }
}

/** The language pinned for a thread, undefined before ingress saw any message there (e.g. after a restart). */
export const pinnedThreadLanguage = (threadId: string): OwnerLanguage | undefined =>
  pinned.get(threadId);

/** Render only what the application knows happened (copy tables live in `notice-text-*.ts`). */
function render(event: UserNotice, language: OwnerLanguage): string {
  if (isPlanNotice(event)) return renderPlanNotice(event, language);
  return isUiNotice(event) ? renderUiNotice(event, language) : renderRunNotice(event, language);
}

/**
 * Every source-language (English) notice rendered by the app registers itself here (text -> event), so the boundary
 * can render it again in the owner's language without a hand-kept table: a new notice cannot be forgotten.
 */
const SOURCE_NOTICES = new Map<string, UserNotice>();

/** Render a notice in the owner's language (source-language renders are remembered for `localizeUserCopy`). */
export function renderUserNotice(event: UserNotice, language: OwnerLanguage): string {
  const text = render(event, language);
  // Outcomes with times and approval/choice texts (labels, owner words) are never matched back by text.
  const dynamic =
    event.kind === "approval" ||
    event.kind === "choice" ||
    event.kind === "label" ||
    event.kind === "plan-revised" ||
    (event.kind === "outcome" && event.resetsAt);
  if (language === SOURCE_LANGUAGE && !dynamic) SOURCE_NOTICES.set(text, event);
  return text;
}

/**
 * Localize app-generated notices that deeper code rendered in the source language (English). Only a LINE that equals a registered notice
 * is replaced, so a model's sentence that merely contains the same words (or an answer in the middle of a line)
 * is never rewritten.
 */
export function localizeUserCopy(text: string, language: OwnerLanguage): string {
  if (language === SOURCE_LANGUAGE) return text;
  return text
    .split("\n")
    .map((line) => {
      const event = SOURCE_NOTICES.get(line);
      return event ? render(event, language) : line;
    })
    .join("\n");
}
