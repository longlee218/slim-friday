import type { Database } from "bun:sqlite";
import type { OwnerLanguage } from "../../ingress/user-copy";
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
  const goals = goalIdsOfThread(db, threadId);
  const ask =
    language === "vi"
      ? "Dọn sạch thùng rác của thread này? Không thể hoàn tác."
      : "Empty the trash of this thread now? This cannot be undone.";
  if (!(await confirm(ask)))
    return language === "vi" ? "Đã hủy: thùng rác giữ nguyên." : "Cancelled: the trash is kept.";
  const n = purgeGoalTrash(agentHome, goals);
  if (language === "vi")
    return n
      ? `Đã dọn thùng rác của ${n} mục tiêu trong thread này.`
      : "Thùng rác của thread này đang trống.";
  return n
    ? `Emptied the trash of ${n} goal(s) of this thread.`
    : "The trash of this thread is empty.";
}
