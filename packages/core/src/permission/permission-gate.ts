import type { PermissionSettings } from "../domain/autonomy";
import type { CardRow } from "../domain/card";
import type { ToolCall } from "../domain/tool";
import type { ToolDecision } from "../ports/agent-runtime";
import type { Clock } from "../ports/clock";
import type { Store } from "../ports/store";
import type { Surface } from "../ports/surface";
import type { ToolCatalog } from "../ports/tool-catalog";
import { redactSecrets, redactValue, secretsFrom } from "../safety/redact-secrets";
import { scopeOf } from "./classify-tool";
import { decide } from "./decide";
import { inputHash } from "./input-hash";

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
}

/** The run a call belongs to, as the gate needs it. */
export interface GateContext {
  /** The run (wake) that makes the call; its card waits for the owner. */
  wakeId: string;
  /** The run's session scope (`<botId>` or `<botId>@<groupId>`). */
  scopeKey: string;
  /** The run read untrusted input (spec "Taint flag"); recorded only, the stricter policy is later work. */
  tainted: boolean;
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
    const verdict = decide({
      call,
      spec,
      grants: await store.grants.list(call.botId),
      settings: this.deps.settings(),
      floorDenyReason,
      now: clock.now(),
    });
    const audit = (reason: string) =>
      store.audit.append({
        at: clock.now(),
        botId: call.botId,
        tool: call.tool,
        outcome: verdict.outcome,
        reason,
      });

    if (verdict.outcome === "allow") {
      await audit(verdict.reason);
      return { behavior: "allow" };
    }
    if (verdict.outcome === "deny") {
      await audit(verdict.reason);
      return { behavior: "deny", reason: verdict.reason };
    }
    const hash = await inputHash(call.tool, call.input);
    // The exact call the owner approved before the run parked; the caller spends the one shot.
    if (ctx.oneShot !== undefined && ctx.oneShot === hash) {
      await audit("approved by the owner");
      return { behavior: "allow" };
    }
    // "Always allow" only for a tool the catalog knows, with plain scope values (a "*" would become a wildcard grant).
    const offerAlways =
      verdict.outcome === "ask" &&
      spec !== undefined &&
      Object.values(scope).every((v) => v !== "*");
    // The card shows the call redacted; the hash stays that of the real input (it is what the one shot matches).
    const secrets = secretsFrom(this.deps.secretValues);
    const shownScope = redactValue(scope, secrets);
    // A scope with a secret in it must never become a stored "always" grant.
    const scopeClean = JSON.stringify(shownScope) === JSON.stringify(scope);
    const card: CardRow = {
      id: `card-${crypto.randomUUID()}`,
      kind: "approval",
      wakeId: ctx.wakeId,
      botId: call.botId,
      conversationId: call.conversationId,
      scopeKey: ctx.scopeKey,
      approval: {
        tool: call.tool,
        input: redactValue(call.input, secrets),
        inputHash: hash,
        summary: redactSecrets(
          [call.tool, ...Object.entries(scope).map(([k, v]) => `${k}=${v}`)].join(" "),
          secrets,
        ),
        scope: shownScope,
        offerAlways: offerAlways && scopeClean,
      },
      status: "open",
      createdAt: clock.now(),
    };
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
    await audit(verdict.reason);
    // The card is stored first: a surface that fails to show it now shows it after a restart.
    try {
      this.deps.surface.showCard(card, botName);
    } catch {
      // Best effort; the stored card is the truth.
    }
    return { behavior: "park", cardId: card.id };
  }
}
