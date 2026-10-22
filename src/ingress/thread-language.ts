import type { Database } from "bun:sqlite";
import { latestBriefOfThread } from "../storage/run-store";
import { languageOf, type OwnerLanguage, pinnedThreadLanguage } from "./user-copy";

/**
 * Language of a thread: the one ingress pinned for its messages. Only when none is pinned yet (e.g. a notice right
 * after a restart) it falls back to the latest task brief; Vietnamese when unknown.
 */
export function threadLanguage(db: Database, threadId: string): OwnerLanguage {
  const pinned = pinnedThreadLanguage(threadId);
  if (pinned) return pinned;
  return languageOf(latestBriefOfThread(db, threadId) ?? "");
}
