import type { Database } from "bun:sqlite";
import {
  type ActionRowBuilder,
  AttachmentBuilder,
  ButtonStyle,
  type Client,
  type Interaction,
  type MessageActionRowComponentBuilder,
  MessageFlags,
} from "discord.js";
import {
  ANSWER_FIELD,
  buildAnswerModal,
  buildChoiceRows,
  CHOICE_PREFIX,
  choiceLayout,
  ENTER_VALUE,
  TYPED_PREFIX,
  threadLanguage,
} from "../ingress/discord-components";
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
  settleClick,
  settledLine,
  toResult,
} from "./approval-buttons";
import type { ApprovalGateway, ApprovalRequest, ApprovalResult } from "./approval-types";

/** Inline summary cap; longer text goes in the attachment. */
const SUMMARY_MAX = 1500;

/** Chars of a long question kept inline as the stem above the buttons (the full text is the attachment). */
const STEM_MAX = 300;

/** Short stem of a long question: its first lines, cut, and a pointer to the attachment. */
const questionStem = (q: string, language: OwnerLanguage): string =>
  `${clip(q.trim(), STEM_MAX)}\n\n${renderUserNotice({ kind: "approval", state: "full-text" }, language)}`;

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

  /** Reply only the owner sees (wrong user, expired request). */
  const whisper = (
    i: { reply: (o: { content: string; flags: MessageFlags.Ephemeral }) => Promise<unknown> },
    state: "owner-only" | "expired",
    language: OwnerLanguage,
  ) =>
    i.reply({
      content: renderUserNotice({ kind: "approval", state }, language),
      flags: MessageFlags.Ephemeral,
    });

  return {
    request: (req) => decide(req, undefined, "owner denied"),
    confirm: (req, labels) => decide(req, labels, "owner declined"),

    async askChoice(a) {
      const language = threadLanguage(db, a.threadId);
      const layout = choiceLayout(a.options);
      // A question longer than a Discord message (a plan to approve) goes out as an attachment under a short stem.
      const long = a.question.length > SUMMARY_MAX;
      // Options that do not fit a button row or a select menu are listed in the attachment; the owner types the answer.
      const listed = layout === "modal" && a.options.length > 0;
      const detail = [
        long ? a.question : "",
        listed ? a.options.map((o) => `- ${o}`).join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const base = long ? questionStem(a.question, language) : a.question;
      const value = await ask({
        turnId: a.turnId,
        threadId: a.threadId,
        tool: ASK_USER_QUESTION_TOOL_NAME,
        prefix: "choice",
        text: listed
          ? `${base}\n\n${renderUserNotice({ kind: "approval", state: "options-in-file" }, language)}`
          : base,
        detail: detail || undefined,
        labels: a.options,
        rows: (id) => buildChoiceRows(id, a.options, layout, language),
        language,
      });
      if (value === undefined || value === "no-channel" || value === "cancelled") return undefined;
      if (value.startsWith(TYPED_PREFIX)) return value.slice(TYPED_PREFIX.length);
      return a.options[Number(value)];
    },

    cancelTurn: (turnId) => cancelPending(pending, turnId),

    async handleInteraction(i) {
      try {
        // Short-circuit order: a button never asks the other type guards.
        if (!(i.isButton() || i.isStringSelectMenu() || i.isModalSubmit())) return;
        const isModal = !i.isButton() && !i.isStringSelectMenu();
        const [prefix, id, value] = i.customId.split(":");
        if ((prefix !== "appr" && prefix !== CHOICE_PREFIX) || !id || value === undefined) return;
        // Approve/deny stay explicit buttons; selects and modals belong to questions only.
        if (prefix === "appr" && !i.isButton()) return;
        const language = threadLanguage(db, i.channelId ?? "");
        // Validate owner and pending id before anything mutates.
        if (i.user.id !== ownerId) return void (await whisper(i, "owner-only", language));
        const p = pending.get(id);
        if (!p) return void (await whisper(i, "expired", language));

        // "Enter answer": the modal is the response (it must open within Discord's deadline); nothing settles yet.
        if (i.isButton() && prefix === CHOICE_PREFIX && value === ENTER_VALUE) {
          await i.showModal(buildAnswerModal(id, p.language));
          return;
        }
        // The answer: an option index (button, select) or the typed text (modal).
        const answer = i.isButton()
          ? value
          : i.isStringSelectMenu()
            ? i.values[0]
            : `${TYPED_PREFIX}${i.fields.getTextInputValue(ANSWER_FIELD).trim()}`;
        if (answer === undefined || answer === TYPED_PREFIX) {
          if (isModal) await i.deferUpdate(); // blank answer: keep the question open
          return;
        }
        pending.delete(id);
        clearTimeout(p.timer); // the timeout must not fire while the ack is in flight
        const line = settledLine(p, prefix, answer);
        // ACK first (3 s deadline), then the slower persistence and resolving the waiter.
        try {
          if (isModal && !i.isFromMessage())
            await i.reply({ content: line, flags: MessageFlags.Ephemeral });
          else await i.update({ content: `${p.content}\n\n${line}`, components: [] });
        } catch (err) {
          log.warn({ err: errText(err) }, "approval ack failed");
          void p.edit(`${p.content}\n\n${line}`);
        }
        settleClick(p, prefix, answer);
      } catch (err) {
        log.warn({ err: errText(err) }, "approval interaction failed");
      }
    },
  };
}
