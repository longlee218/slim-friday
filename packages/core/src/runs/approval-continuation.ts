import type { Bot } from "../domain/bot";
import type { CardRow } from "../domain/card";
import type { QuestionAnswer } from "../domain/question";
import { stableJson } from "../permission/input-hash";

/** What the bot is told when the owner denied a call (spec text). */
export const DENIAL_TEXT =
  "The user denied this action. Do not retry or rephrase it; tell the user and ask what they want instead.";

/** The tool and input of an approval card as the bot reads them: `Bash {"command":"ls"}`. */
const callText = (a: NonNullable<CardRow["approval"]>) => `${a.tool} ${stableJson(a.input)}`;

/**
 * The resume text of an approval card (spec "Cards that survive"). Approved: the exact call to make again,
 * since the resumed model re-issues it only when told (spike finding). Denied (or withdrawn): the denial text.
 * Approved but the tool is gone (config changed): the bot is told so instead of replaying blindly.
 */
export function approvalContinuation(card: CardRow, toolStillExists: boolean): string {
  const a = card.approval;
  if (!a) return DENIAL_TEXT;
  const approved =
    card.status !== "withdrawn" && (card.answer === "once" || card.answer === "always");
  if (!approved) return DENIAL_TEXT;
  if (!toolStillExists) return `The tool ${a.tool} is no longer available to you; tell the owner.`;
  return `The owner approved: ${callText(a)}. Call exactly this request, in this order, with these arguments, and do not ask for approval again.`;
}

/** The owner's answer as one line: chosen options joined by ", ", then the typed text. */
const answerText = (a: QuestionAnswer) =>
  [a.choices.join(", "), a.text?.trim() ?? ""].filter((s) => s).join(" - ");

/**
 * The resume text of a question card: the owner's answer as the reply to the question, or, for a question
 * withdrawn because the owner wrote something else, that note (the owner's message follows as steering or a
 * new run, see intake).
 */
export function questionContinuation(card: CardRow): string {
  const q = card.question?.question ?? "";
  if (card.status === "withdrawn" || !card.answer || typeof card.answer === "string")
    return `Your question "${q}" was withdrawn because the owner wrote something else instead.`;
  return `The owner answered your question "${q}": ${answerText(card.answer)}`;
}

/** Prefix of MCP tool names: `mcp__<server>__<tool>`. */
const MCP = "mcp__";

/**
 * True when `tool` is still granted to the bot (as shaped for its scope, from the current config) or to one of
 * its subagents: the exact name, or the whole MCP server it belongs to.
 */
export function toolStillExists(bot: Bot, tool: string): boolean {
  const names = [...bot.tools, ...bot.subagents.flatMap((s) => s.tools)];
  const server = tool.startsWith(MCP) ? tool.split("__").slice(0, 2).join("__") : undefined;
  return names.includes(tool) || (server !== undefined && names.includes(server));
}
