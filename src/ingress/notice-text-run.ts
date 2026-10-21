import type { OwnerLanguage } from "../i18n/languages";
import { type MessageKey, t } from "../i18n/translate";
import type { UserNotice } from "./user-copy";

/** Notices about the state of a run: start, queue, steer, stop, outcome, failure, note, decision. */
export type RunNotice = Extract<
  UserNotice,
  {
    kind:
      | "start"
      | "steer"
      | "queue"
      | "clarification"
      | "stop"
      | "replacement"
      | "outcome"
      | "failure"
      | "note"
      | "decision";
  }
>;

/** Render a run notice from application facts only, with no claim that a model applied an unread message. */
export function renderRunNotice(event: RunNotice, language: OwnerLanguage): string {
  switch (event.kind) {
    case "start":
      return t(language, "run.start");
    case "steer":
      return t(language, `run.steer.${event.state}`);
    case "queue":
      return t(language, event.full ? "run.queue.full" : "run.queue.received");
    case "clarification":
      return t(language, event.pending ? "run.clarification.pending" : "run.clarification.ask");
    case "replacement":
      return t(language, "run.replacement");
    case "stop":
      return t(language, event.active ? "run.stop.active" : "run.stop.idle");
    case "outcome": {
      const text = t(language, outcomeKey(event.outcome));
      if (event.outcome !== "quota" || !event.resetsAt) return text;
      const at = new Date(event.resetsAt).toISOString();
      return text + t(language, "run.outcome.retryAfter", { at });
    }
    case "failure": {
      // No known cause: the generic "did not finish" outcome.
      if (!event.cause) return renderRunNotice({ kind: "outcome", outcome: "error" }, language);
      const names = event.cause === "location" && event.names?.length ? event.names.join(", ") : "";
      const known = names ? t(language, "run.failure.validLocations", { names }) : "";
      return t(language, `run.failure.${event.cause}`) + known;
    }
    case "note":
      return t(language, `run.note.${event.state}`);
    case "decision":
      return t(language, `run.decision.${event.state}`);
  }
}

/** Outcomes with their own text; any other outcome reads as the generic "did not finish". */
const OUTCOME_KEYS = ["aborted", "quota", "max_budget", "max_turns", "timeout"] as const;

/** Catalog key of an outcome. */
function outcomeKey(outcome: string): MessageKey {
  const known = OUTCOME_KEYS.find((k) => k === outcome);
  return known ? `run.outcome.${known}` : "run.outcome.other";
}
