import type { ApprovalCardDto } from "@friday/contracts";

/** A tool's display name: MCP ids `mcp__<server>__<Name>` show as `<Name>`. */
export function toolLabel(tool: string): string {
  return tool.replace(/^mcp__.+?__/, "");
}

/** The card has no title field; the UI words it: `"Dev wants to use GitPush"`. */
export function approvalTitle(card: ApprovalCardDto): string {
  return `${card.botName} wants to use ${toolLabel(card.tool)}`;
}

/** The scope value shown in receipts: the second one (the prototype's pick), else the first. */
export function scopeLine(scope: Record<string, string>): string {
  const values = Object.values(scope);
  return values[1] ?? values[0] ?? "";
}

/** Verb of the desktop receipt line, by answer. */
export const APPROVAL_VERB = {
  once: "You allowed once",
  always: "You always allow",
  deny: "You denied",
} as const;

/** The "Always" button: a web fetch card allows its site (registrable domain), any other card the tool. */
export function alwaysLabel(card: ApprovalCardDto): string {
  return card.alwaysSite ? `Always allow ${card.alwaysSite}` : "Always allow";
}

/**
 * The phone row's second line: the summary's first line, else the scope; nothing when it would
 * only repeat the tool the title already names.
 */
export function approvalSubtitle(card: ApprovalCardDto): string | undefined {
  const tool = toolLabel(card.tool);
  const repeats = (s: string) => !s || s === card.tool || s === tool;
  const first = card.summary.split("\n")[0]?.trim() ?? "";
  if (!repeats(first)) return first;
  const scope = scopeLine(card.scope).trim();
  return repeats(scope) ? undefined : scope;
}
