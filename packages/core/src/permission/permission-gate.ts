import type { PermissionSettings } from "../domain/autonomy";
import type { ToolCall } from "../domain/tool";
import type { ToolDecision } from "../ports/agent-runtime";
import type { AutoReviewer } from "../ports/auto-review";
import type { Clock } from "../ports/clock";
import type { AuditEntry, Store } from "../ports/store";
import type { Surface } from "../ports/surface";
import type { ToolCatalog } from "../ports/tool-catalog";
import { secretsFrom } from "../safety/redact-secrets";
import { buildApprovalCard } from "./approval-card";
import { reviewIfAsked } from "./auto-review-step";
import { scopeOf } from "./classify-tool";
import { decide } from "./decide";
import { inputHash } from "./input-hash";
import { exactHost, type RegistrableDomain } from "./owner-sites";
import { fetchSiteOf, type TaintRun, taintAskOf } from "./taint-policy";

/** Deny reason for a call that needs approval while the same run already waits on a card. */
export const WAITING_TEXT = "waiting for the owner's answer to an earlier request";

export interface PermissionGateDeps {
  store: Store;
  /** Shows a new card to the owner (after it is stored). */
  surface: Surface;
  catalog: ToolCatalog;
  clock: Clock;
  /** Read at every call, so a settings change applies at once. */
  settings: () => PermissionSettings;
  /** The configured secret values to hide on a card (the app's denied env values); unset: only token patterns. */
  secretValues?: () => string[];
  /** Registrable domain of a host by the Public Suffix List (the app's); unset: the exact host (`exactHost`). */
  registrableDomain?: RegistrableDomain;
  /** Auto Review's judge (spec §6.14), asked only while `settings().autoReview` is on; unset: never asked. */
  autoReviewer?: AutoReviewer;
  /** How long the judge may take (ms); default `AUTO_REVIEW_TIMEOUT_MS` (10 s). Tests pass a short one. */
  autoReviewTimeoutMs?: number;
}

/** The run a call belongs to, as the gate needs it. */
export interface GateContext {
  /** The run (wake) that makes the call; its card waits for the owner. */
  wakeId: string;
  /** The run's session scope (`<botId>` or `<botId>@<groupId>`). */
  scopeKey: string;
  /** The run read untrusted input (spec §6.10): the taint asks of `taint-policy.ts` apply. */
  tainted: boolean;
  /** The run's owner-named and approved sites and approved MCP servers; unset: none (every taint ask asks). */
  taint?: Omit<TaintRun, "tainted">;
  /** The run's chain (`row.chainId`): Auto Review reads the owner's words from it; unset: no review. */
  chainId?: string;
  /** Input hash of the call the owner approved for this resumed run: that exact call is allowed. */
  oneShot?: string;
  /**
   * Called synchronously right before a card is stored: false when the run already has an ask in flight (the
   * call is then denied with `WAITING_TEXT`). It marks the ask as pending, so a concurrent call of the same run
   * never reaches the store.
   */
  reserve?: () => boolean;
  /** Undoes `reserve` when no card was stored. */
  release?: () => void;
}

/**
 * Turns the pure decision into an action: allows, denies, or writes an approval card and parks the run (the
 * owner's answer reaches the bot when the run resumes; nothing waits on a promise and nothing times out).
 */
export class PermissionGate {
  constructor(private deps: PermissionGateDeps) {}

  /** The registrable-domain function of the taint policy (sites in owner texts and fetch urls). */
  get domainOf(): RegistrableDomain {
    return this.deps.registrableDomain ?? exactHost;
  }

  /** Decide one call; every call is audited once. Any failure on the way is a deny. */
  async decide(
    call: ToolCall,
    botName: string,
    ctx: GateContext,
    floorDenyReason?: string,
  ): Promise<ToolDecision> {
    try {
      return await this.decideOrThrow(call, botName, ctx, floorDenyReason);
    } catch (err) {
      return {
        behavior: "deny",
        reason: `permission check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async decideOrThrow(
    call: ToolCall,
    botName: string,
    ctx: GateContext,
    floorDenyReason?: string,
  ): Promise<ToolDecision> {
    const { store, catalog, clock } = this.deps;
    const spec = (await catalog.list()).find((t) => t.name === call.tool);
    const scope = scopeOf(call, spec);
    const none = new Set<string>();
    const taint = taintAskOf(
      call,
      {
        sites: none,
        approvedSites: none,
        usedMcpServers: none,
        ...ctx.taint,
        tainted: ctx.tainted,
      },
      this.domainOf,
    );
    const site = call.tool === "WebFetch" ? fetchSiteOf(call, this.domainOf) : undefined;
    const settings = this.deps.settings();
    const verdict = decide({
      call,
      spec,
      grants: await store.grants.list(call.botId),
      settings,
      floorDenyReason,
      now: clock.now(),
      ...(taint && { taint }),
      ...(site && { site }),
    });
    const audit = (reason: string, review?: AuditEntry["review"], outcome = verdict.outcome) =>
      store.audit.append({
        at: clock.now(),
        botId: call.botId,
        tool: call.tool,
        outcome,
        reason,
        ...(review && { review }),
      });

    if (verdict.outcome === "allow" || verdict.outcome === "deny") {
      await audit(verdict.reason);
      return verdict.outcome === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", reason: verdict.reason };
    }
    const hash = await inputHash(call.tool, call.input);
    // The exact call the owner approved before the run parked; the caller spends the one shot.
    if (ctx.oneShot !== undefined && ctx.oneShot === hash) {
      await audit("approved by the owner");
      return { behavior: "allow" };
    }
    const secrets = secretsFrom(this.deps.secretValues);
    // Auto Review (spec §6.14): only a plain level ask of a clean run with a chain, only while the setting is on.
    const { chainId, tainted } = ctx;
    const review = await reviewIfAsked(
      this.deps,
      call,
      verdict,
      settings,
      chainId,
      tainted,
      secrets,
    );
    if (review?.decision === "pass") {
      await audit(`auto review: ${review.reason}`, review, "allow");
      return { behavior: "allow" };
    }
    // The card shows the call redacted; the hash stays that of the real input (it is what the one shot matches).
    const card = buildApprovalCard({
      call,
      spec,
      scope,
      site,
      verdict,
      hash,
      wakeId: ctx.wakeId,
      scopeKey: ctx.scopeKey,
      tainted: ctx.tainted,
      secrets,
      now: clock.now(),
      ...(review && { lead: review.reason }),
    });
    // Only the first call of a step gets a card: a pending ask of the run (in this process) or an open card of
    // the run (in the store, checked in the same write as the insert) denies the others.
    if (ctx.reserve && !ctx.reserve()) {
      await audit(WAITING_TEXT);
      return { behavior: "deny", reason: WAITING_TEXT };
    }
    if (!(await store.cards.insertIfNoneOpen([card]))) {
      ctx.release?.();
      await audit(WAITING_TEXT);
      return { behavior: "deny", reason: WAITING_TEXT };
    }
    await audit(verdict.reason, review);
    // The card is stored first: a surface that fails to show it now shows it after a restart.
    try {
      this.deps.surface.showCard(card, botName);
    } catch {
      // Best effort; the stored card is the truth.
    }
    return { behavior: "park", cardId: card.id };
  }
}
