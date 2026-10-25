import type { CardRow } from "../domain/card";
import type { ToolCall, ToolSpec } from "../domain/tool";
import { redactSecrets, redactValue } from "../safety/redact-secrets";
import type { Decision } from "./decide";

/** What one approval card is built from. */
export interface ApprovalCardInput {
  call: ToolCall;
  /** The catalog entry of the tool; unset for a tool the catalog does not know (never "Always"). */
  spec: ToolSpec | undefined;
  /** The call's scope values (`scopeOf`). */
  scope: Record<string, string>;
  /** Registrable domain of a `WebFetch` url, when it has one. */
  site: string | undefined;
  verdict: Decision;
  /** Input hash of the real (not redacted) call: what the one shot matches. */
  hash: string;
  /** The run the card parks. */
  wakeId: string;
  scopeKey: string;
  /** The run read untrusted input. */
  tainted: boolean;
  /** Secret values hidden on the card. */
  secrets: readonly string[];
  now: number;
  /** Shown first in the card's text (the Auto Review reason, spec §6.14). */
  lead?: string;
}

/**
 * The approval card of one asked call, redacted. "Always allow" only for a tool the catalog knows: a tool rule needs
 * plain scope values (a "*" would become a wildcard rule) and a scope with no secret in it; a site rule a site with no
 * secret in it.
 */
export function buildApprovalCard(i: ApprovalCardInput): CardRow {
  const { call, scope, site, verdict, secrets } = i;
  const shownScope = redactValue(scope, secrets);
  const alwaysSite = verdict.always === "site" ? site : undefined;
  const offerAlways =
    i.spec !== undefined &&
    (verdict.always === "tool"
      ? Object.values(scope).every((v) => v !== "*") &&
        JSON.stringify(shownScope) === JSON.stringify(scope)
      : alwaysSite !== undefined && redactSecrets(alwaysSite, secrets) === alwaysSite);
  // A taint card says why it asks (spec §6.10).
  const summary = redactSecrets(
    [call.tool, ...Object.entries(scope).map(([k, v]) => `${k}=${v}`)].join(" ") +
      (verdict.reason.startsWith("tainted: ") ? ` (${verdict.reason})` : ""),
    secrets,
  );
  return {
    id: `card-${crypto.randomUUID()}`,
    kind: "approval",
    wakeId: i.wakeId,
    botId: call.botId,
    conversationId: call.conversationId,
    scopeKey: i.scopeKey,
    approval: {
      tool: call.tool,
      input: redactValue(call.input, secrets),
      inputHash: i.hash,
      summary: i.lead ? `${redactSecrets(i.lead, secrets)} | ${summary}` : summary,
      scope: shownScope,
      offerAlways,
      ...(offerAlways && alwaysSite && { always: { match: "site" as const, value: alwaysSite } }),
      // Asked in a tainted run: only such an approval restores a site or server on resume (`restoreTaint`).
      ...(i.tainted && { tainted: true }),
    },
    status: "open",
    createdAt: i.now,
  };
}
