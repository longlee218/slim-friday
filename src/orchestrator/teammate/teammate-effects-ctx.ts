import type { Database } from "bun:sqlite";
import type { OwnerLanguage } from "../../ingress/user-copy";
import { spawnRunner } from "../../locations/git-run";
import type { ApprovalGateway } from "../../owner-approval/approval-types";
import { ownerConfirm } from "../../owner-approval/owner-confirm";
import type { EffectsCtx } from "../../policy/effect-context";
import { ownerPerActEnvelope } from "../../policy/envelope";

/** What a teammate run needs to hold the effect tools. */
interface TeammateEffectsScope {
  db: Database;
  approvals: ApprovalGateway | undefined;
  agentHome: string;
  threadId: string;
  turnId: string;
  language: OwnerLanguage;
  /** The run's own dir: deletes there are inside the envelope too. */
  scratchDir: string;
  /** The channel's locations. */
  locations: { name: string; path: string }[];
  /** `/stop`: ends an open question with "no". */
  signal?: AbortSignal;
}

/**
 * The effect tools' ctx of a TEAMMATE run. There is no goal and no grant: every act asks the owner (`ownerPerAct`, yes / no,
 * fail closed), in the tool handler, so it holds in every SDK permission mode (the SDK guard never sees these questions).
 * The audit rows carry the run key (`run-<turnId>`) as their goal, and the trash is keyed by it.
 */
export function teammateEffectsCtx(s: TeammateEffectsScope): EffectsCtx {
  const runKey = `run-${s.turnId}`;
  return {
    db: s.db,
    threadId: s.threadId,
    goalId: runKey,
    itemId: s.turnId,
    envelope: ownerPerActEnvelope(
      runKey,
      s.locations.map((l) => l.name),
      s.scratchDir,
    ),
    ownerPerAct: true,
    locations: s.locations,
    agentHome: s.agentHome,
    confirm: (summary) =>
      ownerConfirm(s.approvals, {
        kind: "effect",
        turnId: s.turnId,
        threadId: s.threadId,
        summary,
        language: s.language,
        signal: s.signal,
      }),
    run: spawnRunner,
  };
}
