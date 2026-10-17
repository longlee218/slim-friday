import type { Database } from "bun:sqlite";
import {
  type ActionRowBuilder,
  AttachmentBuilder,
  ButtonStyle,
  type Client,
  type Interaction,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import { buildChoiceRows, TYPED_PREFIX, threadLanguage } from "../ingress/discord-components";
import { SAFE_MENTIONS } from "../ingress/discord-message-rules";
import { type OwnerLanguage, renderUserNotice } from "../ingress/user-copy";
import { logEvent, logger, runWithLogContext, tryLog } from "../observability/logger";
import { clip, errText, redactText } from "../observability/redact";
import { type ApprovalDecision, decideApproval, insertApproval } from "../storage/approval-store";
import { setTurnStatus } from "../storage/run-store";
import { ASK_USER_QUESTION_TOOL_NAME } from "../tools/sdk-tool-names";
import {
  type ButtonSpec,
  buildButtonRows,
  cancelPending,
  type Pending,
  toResult,
} from "./approval-buttons";
import { handleApprovalInteraction } from "./approval-interaction";
import { buildChoicePrompt, SUMMARY_MAX } from "./approval-text";
import type { ApprovalGateway, ApprovalRequest, ApprovalResult } from "./approval-types";

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
   * Post a message with buttons and wait for a click.
   * `rows` builds the controls from the request id (customId = `${prefix}:${id}:${value}`).
   * Resolves undefined on timeout, "no-channel" if unsendable.
   */
  async function ask(o: {
    turnId: string;
    threadId: string;
    tool: string;
    prefix: "appr" | "choice";
    text: string;
    detail?: string;
    /** Option labels in the order of their values (shown back to the owner once answered). */
    labels: string[];
    rows: (id: string) => ActionRowBuilder<MessageActionRowComponentBuilder>[];
    language: OwnerLanguage;
    /** Runs after a successful send; a failure there never affects the question. */
    onPosted?: () => void | Promise<void>;
  }): Promise<string | undefined> {
    const id = crypto.randomUUID().slice(0, 8);
    const summary = redactText(o.text);
    // Both approval lines share these fields; the owner's wait is measured from the request.
    const alog = log.child({ tool: o.tool, approvalId: id });
    const t0 = Date.now();
    logEvent(alog, "approval.requested", { summary: clip(summary, 300) });
    safeDb(() => insertApproval(db, { id, turnId: o.turnId, tool: o.tool, summary }));
    safeDb(() => setTurnStatus(db, o.turnId, "waiting_approval"));

    const finish = (decision: ApprovalDecision) => {
      // A button click runs in discord.js's event context, not the task's: re-enter the task's context.
      // log schema key kept (taskId)
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
      const files = o.detail
        ? [
            new AttachmentBuilder(Buffer.from(redactText(o.detail)), {
              name: `${o.tool}-detail.txt`,
            }),
          ]
        : [];
      const msg = await channel.send({
        content,
        components: rows,
        files,
        allowedMentions: SAFE_MENTIONS,
      });
      // The question is now the first thing the owner sees: settle the message receipt (only after a successful send).
      await Promise.resolve(o.onPosted?.()).catch((err: unknown) =>
        log.warn({ err: errText(err) }, "approval onPosted failed"),
      );
      return await new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          const p = pending.get(id);
          pending.delete(id);
          finish("timeout");
          // best effort: drop the controls
          void p?.edit(
            `${content}\n\n${renderUserNotice({ kind: "approval", state: "timeout" }, o.language)}`,
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
          language: o.language,
          finish,
          edit: (c) => msg.edit({ content: c, components: [] }).catch(() => undefined),
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
      { label: yes, value: "allow", style: ButtonStyle.Success },
      { label: no, value: "deny", style: ButtonStyle.Danger },
    ];
    const value = await ask({
      ...req,
      prefix: "appr",
      text: req.summary,
      labels: [yes, no],
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
      const { layout, text, detail } = buildChoicePrompt(a.question, shown, language);
      const value = await ask({
        turnId: a.turnId,
        threadId: a.threadId,
        tool: ASK_USER_QUESTION_TOOL_NAME,
        prefix: "choice",
        text,
        detail,
        labels: shown,
        rows: (id) => buildChoiceRows(id, shown, layout, language),
        language,
      });
      if (value === undefined || value === "no-channel" || value === "cancelled") return undefined;
      if (value.startsWith(TYPED_PREFIX)) return value.slice(TYPED_PREFIX.length);
      return a.options[Number(value)];
    },

    cancelTurn: (turnId) => cancelPending(pending, turnId),

    handleInteraction: (i) => handleApprovalInteraction(i, { db, ownerId, pending, log }),
  };
}
