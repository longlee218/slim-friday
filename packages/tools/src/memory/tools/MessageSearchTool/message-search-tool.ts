import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Author, MessageHit, MessageIndexStore } from "@friday/core";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { ToolSessionContext } from "../../memory-owner";
import { MESSAGE_SEARCH_TOOL } from "./constants";
import { MESSAGE_SEARCH_DESCRIPTION } from "./prompt";

/** Lines returned. */
const LIMIT = 10;
/** Longest message text shown. */
const TEXT_CHARS = 300;

/** What `MessageSearch` reads: the message index, and a way to bring it up to date first. */
export interface MessageSearchDeps {
  index: MessageIndexStore;
  /** Index messages stored since the last search; a failure is the caller's to log (the search still runs). */
  catchUp(): Promise<unknown>;
}

/** Input the model sees. */
const SHAPE = {
  query: z.string().min(2).max(200).describe("A few words to look for."),
};

const pad = (n: number) => String(n).padStart(2, "0");
/** Local `YYYY-MM-DD HH:MM`. */
const stamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const authorName = (a: Author): string => (a.kind === "bot" ? a.botId : a.kind);
const lineOf = (h: MessageHit): string =>
  `[${stamp(h.at)} ${authorName(h.author)}] ${h.text.replace(/\s+/g, " ").slice(0, TEXT_CHARS)}`;

/** `MessageSearch` for one session (read only): only the current conversation and the bot's direct chat. */
export function createMessageSearchTool(deps: MessageSearchDeps, ctx: ToolSessionContext) {
  return tool(
    MESSAGE_SEARCH_TOOL,
    MESSAGE_SEARCH_DESCRIPTION,
    SHAPE,
    async ({ query }) => {
      await deps.catchUp().catch(() => {});
      const [current, direct] = await Promise.all([ctx.conversation(), ctx.direct?.()]);
      const ids = [...new Set([current?.id, direct?.id].filter((id): id is string => !!id))];
      const hits = deps.index.searchMessages(ids, query, LIMIT);
      return textResult(hits.length ? hits.map(lineOf).join("\n") : "no match");
    },
    { annotations: { readOnlyHint: true } },
  );
}
