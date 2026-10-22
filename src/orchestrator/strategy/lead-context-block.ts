import { clip, redactText } from "../../observability/redact";
import { neutralizePromptTags } from "../../text/neutralize-prompt-tags";
import type { TaskSnapshot } from "../goal/effect-port";

/* The per-turn data block of a lead run: goal, criteria and the item table from the db, inside `<goal_state>`. It is
   DATA (the lead contract says so for every user-turn tag), and every free-text cell is redacted and clipped (a worker
   result may hold anything). */

/** Opening tag of the block. */
export const LEAD_DATA_TAG = "<goal_state>";

/** Chars of a result excerpt / question cell in the table. */
const CELL_CHARS = 200;

/** Cell text: redacted, one line, clipped; `-` when empty. */
const cell = (s: string | null | undefined): string =>
  s ? clip(neutralizePromptTags(redactText(s)).replace(/\s+/g, " ").trim(), CELL_CHARS) : "-";

/** Render the block; `criteria` are the plan's acceptance lines when a plan exists. No goal = a one-line "no goal". */
export function buildLeadContextBlock(
  snap: TaskSnapshot,
  criteria: readonly string[] = [],
): string {
  if (!snap.goalId) return `${LEAD_DATA_TAG}\nNo goal yet in this thread.\n</goal_state>`;
  const rows = snap.items.map(
    (it) =>
      `| ${it.id} | ${it.key ?? "-"} | ${it.status} | ${cell(it.pendingQuestion)} | ${it.resultKind ?? "-"} | ${cell(it.resultExcerpt)} | ${it.resultPath ?? "-"} |`,
  );
  return [
    LEAD_DATA_TAG,
    `Goal ${snap.goalId}: ${cell(snap.intent)}`,
    ...(criteria.length ? ["Criteria:", ...criteria.map((c) => `- ${cell(c)}`)] : []),
    "| task | key | status | question | result | excerpt | file |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "</goal_state>",
  ].join("\n");
}
