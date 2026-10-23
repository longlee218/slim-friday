import type { Database } from "bun:sqlite";
import type { OwnerLanguage } from "../../i18n/languages";
import { t } from "../../i18n/translate";
import { effectGoalIdsOfThread } from "../../storage/effect-log-store";
import { goalIdsOfThread } from "../../storage/owned-item-store";
import { purgeGoalTrash } from "./trash-store";

/**
 * `/purge`: empty the trash of THIS thread's goals (never another thread's) and answer in the owner's
 * language. It is final (the audit rows stay), so the owner is asked first with one yes / no click (`confirm`, fail closed: no
 * answer, a stop or no button flow means nothing is emptied).
 */
export async function purgeThreadTrash(
  db: Database,
  agentHome: string,
  threadId: string,
  language: OwnerLanguage,
  confirm: (summary: string) => Promise<boolean>,
): Promise<string> {
  // Goals of the thread, and the run keys of its teammate runs (their trash is keyed by the run).
  const goals = [
    ...new Set([...goalIdsOfThread(db, threadId), ...effectGoalIdsOfThread(db, threadId)]),
  ];
  if (!(await confirm(t(language, "purge.ask")))) return t(language, "purge.cancelled");
  const n = purgeGoalTrash(agentHome, goals);
  return n ? t(language, "purge.done", { count: n }) : t(language, "purge.empty");
}
