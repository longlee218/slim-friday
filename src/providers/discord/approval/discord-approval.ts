import type { Database } from "bun:sqlite";
import type { Client, Interaction } from "discord.js";
import { threadLanguage } from "../../../ingress/thread-language";
import { renderUserNotice } from "../../../ingress/user-copy";
import { logEvent, logger, runWithLogContext, tryLog } from "../../../observability/logger";
import { clip, errText, redactText } from "../../../observability/redact";
import type {
  ApprovalGateway,
  ApprovalRequest,
  ApprovalResult,
} from "../../../owner-approval/approval-types";
import {
  type ApprovalDecision,
  decideApproval,
  insertApproval,
} from "../../../storage/approval-store";
import { setTurnStatus } from "../../../storage/run-store";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../../tools/sdk-tool-names";
import { type ButtonSpec, buildButtonRows, type Intent } from "../ui/components/buttons";
import { buildChoiceRows, TYPED_PREFIX } from "../ui/components/choice";
import { askPayload, settledPayload } from "../ui/messages/ask-message";
import { editMessage, sendMessage } from "../ui/send/reply-port";
import { cancelPending, type Pending, toResult } from "./approval-buttons";
import { handleApprovalInteraction } from "./approval-interaction";
import { buildChoicePrompt, CHOICE_FILE_NAME, SUMMARY_MAX } from "./approval-text";
import type { AskOptions } from "./ask-options";

/** Dependencies of the gateway. */
export interface ApprovalGatewayDeps {
  /** Late-bound: the bot is created after the task handler. */
  getClient: () => Client | undefined;
  ownerId: string;
  db: Database;
  /** Time to wait for the owner before denying. */
  timeoutMs?: number;
}

/** Gateway that asks the owner through buttons in the task's Discord thread. */
export function createDiscordApprovalGateway(
  deps: ApprovalGatewayDeps,
): ApprovalGateway & { handleInteraction(i: Interaction): Promise<void> } {
  const { getClient, ownerId, db, timeoutMs = 600_000 } = deps;
  const log = logger.child({ module: "discord-approval" });
  /** Open requests by approval id. */
  const pending = new Map<string, Pending>();

  /** Run a db write; approvals must never crash the agent on a storage error. */
  const safeDb = (fn: () => void) => tryLog(log, "approval db write failed", fn);
  /**
   * Post a message with buttons and wait for a click. `rows` builds the controls from the request id
   * (customId = `${prefix}:${id}:${value}`). Resolves undefined on timeout, "no-channel" if unsendable.
   */
  async function ask(o: AskOptions): Promise<string | undefined> {
    const id = crypto.randomUUID().slice(0, 8);
    const summary = redactText(o.text);
    const alog = log.child({ tool: o.tool, approvalId: id });
    const t0 = Date.now();
    logEvent(alog, "approval.requested", { summary: clip(summary, 300) });
    safeDb(() => insertApproval(db, { id, turnId: o.turnId, tool: o.tool, summary }));
    safeDb(() => setTurnStatus(db, o.turnId, "waiting_approval"));

    const finish = (decision: ApprovalDecision) => {
      // A click runs in discord.js's event context: re-enter the task's log context (schema key taskId).
      runWithLogContext({ taskId: o.turnId, threadId: o.threadId }, () =>
        logEvent(alog, "approval.decided", { decision, waitMs: Date.now() - t0 }),
      );
      safeDb(() => decideApproval(db, id, decision));
      // A cancelled request belongs to an ended run: never flip its task back to running.
      if (decision !== "cancelled") safeDb(() => setTurnStatus(db, o.turnId, "running"));
    };

    try {
      const channel = await getClient()?.channels.fetch(o.threadId);
      if (!channel?.isSendable()) throw new Error("no channel");
      const rows = o.rows(id);
      const content = clip(summary, SUMMARY_MAX);
      const file = o.detail
        ? { name: o.fileName ?? `${o.tool}-detail.txt`, content: redactText(o.detail) }
        : undefined;
      const msg = await sendMessage(channel, askPayload(content, rows, file));
      tryLog(log, "approval onMessage failed", () => o.onMessage?.(msg.id));
      // The question is the first thing the owner sees: settle the message receipt (only after a send).
      await Promise.resolve(o.onPosted?.()).catch((err: unknown) =>
        log.warn({ err: errText(err) }, "approval onPosted failed"),
      );
      return await new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          const p = pending.get(id);
          pending.delete(id);
          finish("timeout");
          void p?.edit(
            `${content}\n\n${renderUserNotice({ kind: "approval", state: "timeout" }, o.language)}`,
            "warn",
          );
          resolve(undefined);
        }, timeoutMs);
        pending.set(id, {
          turnId: o.turnId,
          threadId: o.threadId,
          settle: resolve,
          timer,
          content,
          labels: o.labels,
          intents: o.intents ?? [],
          language: o.language,
          finish,
          edit: (c, tone) =>
            editMessage(msg, settledPayload(c, tone, file?.name)).catch(() => undefined),
          fileName: file?.name,
        });
      });
    } catch (err) {
      log.warn({ err: errText(err) }, "approval send failed");
      finish("denied");
      return "no-channel";
    }
  }

  /** Shared body of request/confirm; only labels and the deny reason differ. */
  async function decide(
    req: ApprovalRequest,
    labels: [string, string] | undefined,
    denyReason: string,
  ): Promise<ApprovalResult> {
    const language = threadLanguage(db, req.threadId);
    const [yes, no] = labels ?? [
      renderUserNotice({ kind: "approval", state: "approve" }, language),
      renderUserNotice({ kind: "approval", state: "deny" }, language),
    ];
    const buttons: ButtonSpec[] = [
      { label: yes, value: "allow", intent: "approve" },
      { label: no, value: "deny", intent: "reject" },
    ];
    const value = await ask({
      ...req,
      prefix: "appr",
      text: req.summary,
      labels: [yes, no],
      intents: ["approve", "reject"],
      rows: (id) => buildButtonRows("appr", id, buttons),
      language,
      onPosted: req.onPosted,
    });
    return toResult(value, denyReason);
  }

  return {
    request: (req) => decide(req, undefined, "owner denied"),
    confirm: (req, labels) => decide(req, labels, "owner declined"),

    async askChoice(a) {
      const language = threadLanguage(db, a.threadId);
      // Yes/No buttons wear the localized approval labels; the answer value stays the option text.
      const shown = a.yesno
        ? (["approve", "deny"] as const).map((state) =>
            renderUserNotice({ kind: "approval", state }, language),
          )
        : a.options;
      const yesnoIntents: Intent[] = a.yesno ? ["approve", "reject"] : [];
      const { layout, text, detail } = buildChoicePrompt(a.question, shown, language, a.stem);
      const value = await ask({
        turnId: a.turnId,
        threadId: a.threadId,
        tool: ASK_USER_QUESTION_TOOL_NAME,
        prefix: "choice",
        text,
        detail,
        // The owner never sees an internal tool name: a question file is named by its content.
        fileName: a.fileName ?? CHOICE_FILE_NAME,
        labels: shown,
        intents: yesnoIntents,
        rows: (id) => buildChoiceRows(id, shown, layout, language, yesnoIntents),
        language,
        onMessage: a.onMessage,
      });
      if (value === undefined || value === "no-channel" || value === "cancelled") return undefined;
      if (value.startsWith(TYPED_PREFIX)) return value.slice(TYPED_PREFIX.length);
      return a.options[Number(value)];
    },

    cancelTurn: (turnId) => cancelPending(pending, turnId),

    handleInteraction: (i) => handleApprovalInteraction(i, { db, ownerId, pending, log }),
  };
}
