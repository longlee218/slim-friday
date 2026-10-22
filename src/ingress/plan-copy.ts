import type { OwnerLanguage } from "../i18n/languages";
import { t } from "../i18n/translate";
import { CHUNK_MAX } from "./message-limits";

/* Owner text of `/plan` and `/plan history` (every language of the list), worded by app code from facts the orchestrator collected (no
   model). The facts are already redacted and clipped. */

/** What `/plan` shows for the thread. */
export type PlanFacts =
  | { kind: "none" }
  | {
      kind: "current";
      version: number;
      status: string;
      /** Short objective of the goal the plan belongs to. */
      goal?: string | undefined;
      /** Items of the version with their live status. */
      items: { key: string; subject: string; status: string }[];
      url?: string | undefined;
    }
  | {
      kind: "history";
      goal?: string | undefined;
      versions: { version: number; status: string; at: string; reason: string | null }[];
      url?: string | undefined;
    };

/** Builds the facts of a thread's plan (`history` = every version); app code, no model. */
export type PlanLookup = (threadId: string, history: boolean) => PlanFacts;

/** The `/plan` reply text; at most CHUNK_MAX chars: item lines are dropped (never the link, never a cut URL). */
export function renderPlanFacts(f: PlanFacts, language: OwnerLanguage): string {
  if (f.kind === "none") return t(language, "plan.none");
  const goal = f.goal ? [t(language, "plan.goal", { goal: f.goal })] : [];
  const link = f.url ? [t(language, "plan.open", { url: f.url })] : [];
  const head =
    f.kind === "history"
      ? [t(language, "plan.versions"), ...goal]
      : [t(language, "plan.current", { version: f.version, status: f.status }), ...goal];
  const rows =
    f.kind === "history"
      ? f.versions.map(
          (v) => `- v${v.version} ${v.status}, ${v.at}${v.reason ? `: ${v.reason}` : ""}`,
        )
      : f.items.map((i) => `- ${i.key} "${i.subject}": ${i.status}`);
  // Keep the rows that fit beside the head and the link; the dropped ones are counted.
  const fixed = [...head, ...link].join("\n").length;
  const kept: string[] = [];
  let used = fixed + 40; // room for the "more" line
  for (const r of rows) {
    if (used + r.length + 1 > CHUNK_MAX) break;
    kept.push(r);
    used += r.length + 1;
  }
  const more = rows.length - kept.length;
  return [
    ...head,
    ...kept,
    ...(more ? [t(language, "plan.more", { count: more })] : []),
    ...link,
  ].join("\n");
}
