import type { Database } from "bun:sqlite";
import {
  AttachmentBuilder,
  ButtonStyle,
  type Client,
  type Interaction,
  MessageFlags,
} from "discord.js";
import { SAFE_MENTIONS } from "../ingress/discord-message-rules";
import { logEvent, logger, runWithLogContext, tryLog } from "../observability/logger";
import { clip, errText, redactText } from "../observability/redact";
import { type ApprovalDecision, decideApproval, insertApproval } from "../storage/approval-store";
import { setTurnStatus } from "../storage/run-store";
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "../tools/sdk-tool-names";
import {
  type ButtonSpec,
  buildButtonRows,
  cancelPending,
  type Pending,
  settleClick,
  settleWithFeedback,
  toResult,
} from "./approval-buttons";
import type { ApprovalGateway, ApprovalRequest, ApprovalResult } from "./approval-types";
import { createDecisionPoster } from "./clone-decision";

/** Inline summary cap; longer text goes in the attachment. */
const SUMMARY_MAX = 1500;

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
  const decisions = createDecisionPoster({ getClient, ownerId });

  /** Run a db write; approvals must never crash the agent on a storage error. */
  const safeDb = (fn: () => void) => tryLog(log, "approval db write failed", fn);
  /**
   * Post a message with buttons and wait for a click.
   * customId = `${prefix}:${id}:${value}`. Resolves undefined on timeout, "no-channel" if unsendable.
   */
  async function ask(o: {
    turnId: string;
    threadId: string;
    tool: string;
    prefix: "appr" | "choice";
    text: string;
    detail?: string;
    buttons: ButtonSpec[];
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
      const rows = buildButtonRows(o.prefix, id, o.buttons);
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
      return await new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          const p = pending.get(id);
          pending.delete(id);
          finish("timeout");
          void p?.edit(`${content}\n\nTimed out`); // best effort: drop the buttons
          resolve(undefined);
        }, timeoutMs);
        pending.set(id, {
          turnId: o.turnId,
          threadId: o.threadId,
          tool: o.tool,
          settle: resolve,
          timer,
          content,
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

  /** Shared body of request/requestPlan/confirm; only labels and the deny reason differ. */
  async function decide(
    req: ApprovalRequest,
    labels: [string, string],
    denyReason: string,
  ): Promise<ApprovalResult> {
    const value = await ask({
      ...req,
      prefix: "appr",
      text: req.summary,
      buttons: [
        { label: labels[0], value: "allow", style: ButtonStyle.Success },
        { label: labels[1], value: "deny", style: ButtonStyle.Danger },
      ],
    });
    return toResult(value, denyReason);
  }

  return {
    postDecision: decisions.post,
    request: (req) => decide(req, ["Approve", "Deny"], "owner denied"),
    confirm: (req, labels) => decide(req, labels, "owner declined"),
    requestPlan: (req) => decide(req, ["Approve", "Reject"], "owner rejected plan"),
    feedbackPlan: (threadId, text) =>
      settleWithFeedback(pending, threadId, EXIT_PLAN_MODE_TOOL_NAME, text),

    async askChoice(a) {
      const value = await ask({
        turnId: a.turnId,
        threadId: a.threadId,
        tool: ASK_USER_QUESTION_TOOL_NAME,
        prefix: "choice",
        text: a.question,
        buttons: a.options.map((label, i) => ({
          label,
          value: String(i),
          style: ButtonStyle.Primary,
        })),
      });
      if (value === undefined || value === "no-channel" || value === "cancelled") return undefined;
      return a.options[Number(value)];
    },

    cancelTurn: (turnId) => cancelPending(pending, turnId),

    async handleInteraction(i) {
      if (await decisions.handle(i)) return;
      try {
        if (!i.isButton()) return;
        const [prefix, id, value] = i.customId.split(":");
        if ((prefix !== "appr" && prefix !== "choice") || !id || value === undefined) return;
        if (i.user.id !== ownerId) {
          await i.reply({ content: "Only the owner can approve.", flags: MessageFlags.Ephemeral });
          return;
        }
        const p = pending.get(id);
        if (!p) {
          await i.reply({ content: "This action expired.", flags: MessageFlags.Ephemeral });
          return;
        }
        pending.delete(id);
        const label = settleClick(p, prefix, value);
        await i.update({ content: `${p.content}\n\nOwner ${label}`, components: [] });
      } catch (err) {
        log.warn({ err: errText(err) }, "approval interaction failed");
      }
    },
  };
}
