import { CORE_DEFAULTS } from "../config-defaults";
import type { PermissionSettings } from "../domain/autonomy";
import type { ToolCall } from "../domain/tool";
import type { ToolDecision } from "../ports/agent-runtime";
import type { Clock } from "../ports/clock";
import type { Store } from "../ports/store";
import type { ApprovalAnswer, Surface } from "../ports/surface";
import type { ToolCatalog } from "../ports/tool-catalog";
import { scopeOf } from "./classify-tool";
import { decide } from "./decide";

export interface PermissionGateDeps {
  store: Store;
  surface: Surface;
  catalog: ToolCatalog;
  clock: Clock;
  /** Read at every call, so a settings change applies at once. */
  settings: () => PermissionSettings;
  timeoutMs?: number;
}

/** Turns the pure decision into an action: allows, denies, or asks the user and remembers "Always allow". */
export class PermissionGate {
  constructor(private deps: PermissionGateDeps) {}

  /** Decide one call; every call is audited once. Any failure on the way is a deny. */
  async decide(call: ToolCall, botName: string, floorDenyReason?: string): Promise<ToolDecision> {
    try {
      return await this.decideOrThrow(call, botName, floorDenyReason);
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
    const audit = async (reason: string, answer?: ApprovalAnswer) =>
      store.audit.append({
        at: clock.now(),
        botId: call.botId,
        tool: call.tool,
        outcome: verdict.outcome,
        answer,
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

    // "Always allow" only for a tool the catalog knows, with plain scope values (a "*" would become a wildcard grant).
    const offerAlways =
      verdict.outcome === "ask" &&
      spec !== undefined &&
      Object.values(scope).every((v) => v !== "*");
    const answer = await this.ask(call, botName, scope, offerAlways);
    if (answer === "timeout") {
      await audit("approval timed out");
      return { behavior: "deny", reason: "approval timed out" };
    }
    await audit(verdict.reason, answer);
    // Only an explicit once or always allows; anything else (including a malformed answer) denies.
    if (answer !== "once" && answer !== "always")
      return { behavior: "deny", reason: "denied by the user" };
    if (answer === "always" && offerAlways)
      await store.grants.add({
        id: `grant-${call.botId}-${call.tool}-${clock.now()}`,
        botId: call.botId,
        tool: call.tool,
        scope,
        createdAt: clock.now(),
      });
    return { behavior: "allow" };
  }

  /** Ask the surface; a missing answer after the timeout is "timeout", a surface failure is a deny. */
  private ask(
    call: ToolCall,
    botName: string,
    scope: Record<string, string>,
    offerAlways: boolean,
  ): Promise<ApprovalAnswer | "timeout"> {
    const { surface, clock } = this.deps;
    const summary = [call.tool, ...Object.entries(scope).map(([k, v]) => `${k}=${v}`)].join(" ");
    return new Promise((resolve) => {
      const cancel = clock.setTimer(this.deps.timeoutMs ?? CORE_DEFAULTS.approvalTimeoutMs, () =>
        resolve("timeout"),
      );
      Promise.resolve()
        .then(() =>
          surface.askApproval(call.conversationId, {
            botId: call.botId,
            botName,
            tool: call.tool,
            summary,
            scope,
            offerAlways,
            timeoutMs: this.deps.timeoutMs ?? CORE_DEFAULTS.approvalTimeoutMs,
          }),
        )
        .then((a) => {
          cancel();
          resolve(a);
        })
        .catch(() => {
          cancel();
          resolve("deny");
        });
    });
  }
}
