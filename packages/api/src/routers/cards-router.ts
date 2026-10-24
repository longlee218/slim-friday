import { logApiEvent } from "../api-log";
import type { ApiDeps } from "../app";
import { authed } from "../rpc/implementer";

/** Log one answer (ids, kind, answer and latency only; never the text) once the card took it. */
function logAnswered(
  deps: ApiDeps,
  cardId: string,
  kind: "approval" | "question",
  answer: string,
  openedAt: number | undefined,
): void {
  logApiEvent(deps.log, "approval.answered", {
    cardId,
    kind,
    answer,
    ms: openedAt === undefined ? undefined : deps.now() - openedAt,
  });
}

/** Approval cards waiting for the owner; the first answer wins (the stored card is answered once). */
export const approvalsRouter = {
  pending: authed.approvals.pending.handler(({ context }) =>
    context.deps.surface.cards.pendingApprovals(),
  ),
  answer: authed.approvals.answer.handler(async ({ input, context, errors }) => {
    const openedAt = await context.deps.surface.cards.openedAt(input.cardId);
    const r = await context.deps.hub.answerCard(input.cardId, input.answer);
    if (r === "conflict") throw errors.CONFLICT();
    if (r === "not_found") throw errors.NOT_FOUND();
    if (r === "bad_answer") throw errors.BAD_REQUEST();
    logAnswered(context.deps, input.cardId, "approval", input.answer, openedAt);
    return { ok: true as const };
  }),
};

/** Question cards waiting for the owner. */
export const questionsRouter = {
  pending: authed.questions.pending.handler(({ context }) =>
    context.deps.surface.cards.pendingQuestions(),
  ),
  answer: authed.questions.answer.handler(async ({ input, context, errors }) => {
    const openedAt = await context.deps.surface.cards.openedAt(input.cardId);
    const r = await context.deps.hub.answerCard(input.cardId, {
      choices: input.choices ?? [],
      ...(input.text !== undefined && { text: input.text }),
    });
    if (r === "conflict") throw errors.CONFLICT();
    if (r === "not_found") throw errors.NOT_FOUND();
    if (r === "bad_answer") throw errors.BAD_REQUEST();
    logAnswered(
      context.deps,
      input.cardId,
      "question",
      input.choices?.join(",") ?? "text",
      openedAt,
    );
    return { ok: true as const };
  }),
};
