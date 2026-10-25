import type { ApprovalRuleDto, ApprovalRuleInput } from "@friday/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { ScheduledRunsNote } from "../schedules/scheduled-runs-note";
import { Button, IconButton } from "../ui/button";
import { Pill } from "../ui/pill";
import { AutoReviewToggle } from "./auto-review-toggle";
import { SettingsPage } from "./settings-page";

type Match = ApprovalRuleDto["match"];
type Effect = ApprovalRuleDto["effect"];

/** Labels of the match kinds, most specific first (the order rules win in). */
const MATCHES: [Match, string][] = [
  ["site", "Site"],
  ["tool", "Tool"],
  ["server", "MCP server"],
  ["category", "Category"],
];
/** Placeholder of the value field per match kind. */
const PLACEHOLDER: Record<Match, string> = {
  site: "example.com",
  tool: "mcp__github__create_issue",
  server: "github",
  category: "email or purchase",
};
const EFFECT_LABEL: Record<Effect, string> = {
  always_allow: "Always allow",
  require_approval: "Always ask",
};

/** `repo=friday, branch=*` as a scope object; empty text is no scope. */
export function parseScope(text: string): Record<string, string> {
  const scope: Record<string, string> = {};
  for (const part of text.split(",")) {
    const [k, ...v] = part.split("=");
    if (k?.trim()) scope[k.trim()] = v.join("=").trim();
  }
  return scope;
}

/** A scope object as `key=value` pairs. */
const scopeText = (scope: Record<string, string>) =>
  Object.entries(scope)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

/**
 * `/settings/approvals`: the owner's approval rules (spec §6.14). Each rule always allows or always asks for a
 * site, a tool, an MCP server or a category; the most specific rule wins and a tie asks. Add and remove.
 */
export function ApprovalRulesPanel() {
  const qc = useQueryClient();
  const dir = useDirectory();
  const rules = useQuery(orpc.config.approvalRules.list.queryOptions()).data ?? [];
  const [effect, setEffect] = useState<Effect>("require_approval");
  const [match, setMatch] = useState<Match>("site");
  const [botId, setBotId] = useState("*");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: orpc.config.approvalRules.list.key() });

  /** Runs one call; a failure is a toast, a success refreshes the list. */
  async function run(call: () => Promise<unknown>, done: string) {
    try {
      await call();
      await refresh();
      toast.success(done);
      return true;
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "That did not work. Try again.");
      return false;
    }
  }
  async function add() {
    const v = value.trim();
    if (!v) return;
    const input = (
      match === "tool"
        ? { botId, effect, match, value: v, scope: parseScope(scope) }
        : { botId, effect, match, value: v }
    ) as ApprovalRuleInput;
    if (await run(() => client.config.approvalRules.add(input), "Rule added.")) {
      setValue("");
      setScope("");
    }
  }

  return (
    <SettingsPage title="Approval rules">
      <div className="page-head">
        <div className="grow">
          <h2>Approval rules</h2>
          <div className="r">
            Always allow or always ask, by site, tool, MCP server or category. The most specific
            rule wins (site, then tool, server, category); when two rules tie, the bot asks. Bot
            config changes and calls that cannot be undone always ask.
          </div>
        </div>
      </div>
      <div className="list-panel">
        <AutoReviewToggle />
      </div>
      <div className="list-panel">
        {rules.map((r) => (
          <div className="srow" key={r.id}>
            <span className="ico">
              <ShieldCheck size={16} strokeWidth={1.75} />
            </span>
            <div className="grow">
              <Pill tone={r.effect === "always_allow" ? "green" : "amber"}>
                {EFFECT_LABEL[r.effect]}
              </Pill>{" "}
              <b className="mono">{r.value}</b>
              <div className="t2">
                {MATCHES.find(([m]) => m === r.match)?.[1]} ·{" "}
                {r.botId === "*" ? "All bots" : dir.botName(r.botId)}
                {Object.keys(r.scope).length > 0 && ` · ${scopeText(r.scope)}`}
              </div>
            </div>
            <IconButton
              label="Remove rule"
              onClick={() =>
                void run(() => client.config.approvalRules.remove({ id: r.id }), "Rule removed.")
              }
            >
              <Trash2 size={16} strokeWidth={1.75} />
            </IconButton>
          </div>
        ))}
        {rules.length === 0 && (
          <div className="srow">
            <div className="grow t2">No rules yet. "Always allow" on a card adds one.</div>
          </div>
        )}
        <div className="add-row" style={{ flexWrap: "wrap" }}>
          <select
            className="field"
            style={{ width: "auto" }}
            aria-label="Effect"
            value={effect}
            onChange={(e) => setEffect(e.target.value as Effect)}
          >
            <option value="require_approval">{EFFECT_LABEL.require_approval}</option>
            <option value="always_allow">{EFFECT_LABEL.always_allow}</option>
          </select>
          <select
            className="field"
            style={{ width: "auto" }}
            aria-label="Match"
            value={match}
            onChange={(e) => setMatch(e.target.value as Match)}
          >
            {MATCHES.map(([m, label]) => (
              <option key={m} value={m}>
                {label}
              </option>
            ))}
          </select>
          <select
            className="field"
            style={{ width: "auto" }}
            aria-label="Bot"
            value={botId}
            onChange={(e) => setBotId(e.target.value)}
          >
            <option value="*">All bots</option>
            {[...dir.bots.values()].map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <input
            className="field"
            aria-label="Value"
            placeholder={PLACEHOLDER[match]}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
          />
          {match === "tool" && (
            <input
              className="field"
              aria-label="Scope"
              placeholder="Scope, e.g. repo=friday, branch=*"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
          )}
          <Button variant="primary" disabled={!value.trim()} onClick={() => void add()}>
            Add rule
          </Button>
        </div>
      </div>
      <ScheduledRunsNote />
    </SettingsPage>
  );
}
