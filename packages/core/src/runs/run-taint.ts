import type { ToolCall } from "../domain/tool";
import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { ownerSites } from "../permission/owner-sites";
import {
  noteCleanServerUse,
  noteSearchUrls,
  noteTaintAllowed,
  type TaintRun,
  taints,
} from "../permission/taint-policy";
import type { RunExec } from "./run-exec";

/** The taint state of one run beside `exec.tainted` (spec §6.10). */
export interface RunTaint extends Omit<TaintRun, "tainted"> {
  /** Open main-thread tool calls by tool use id: true when the call's result will taint the run. */
  calls: Map<string, boolean>;
  /** Tool use ids of open `WebSearch` calls: their result urls become trusted fetch targets. */
  searchCalls: Set<string>;
  searchUrls: Set<string>;
}

/** A fresh, empty taint state (`seedTaint` fills it once the run starts). */
export function newRunTaint(): RunTaint {
  return {
    sites: new Set(),
    approvedSites: new Set(),
    usedMcpServers: new Set(),
    calls: new Map(),
    searchCalls: new Set(),
    searchUrls: new Set(),
  };
}

/**
 * Whether a claimed run starts tainted (spec §6.10): not started by the owner, resumes a cut or parked run, a
 * second attempt, or stored as tainted by an earlier attempt. An intro run is the exception: its sender is
 * Friday (system) with Friday's fixed text and its only tools are `AskUserQuestion` (own state) and
 * `UpdateProfile`, so nothing outside reaches it; it is tainted only when an attempt stored it so.
 */
export function taintedAtClaim(row: WakeRow, fence: number): boolean {
  if (row.intro) return row.tainted === true;
  return (
    row.sender.kind !== "user" ||
    row.cuts > 0 ||
    row.cardId !== undefined ||
    fence > 1 ||
    row.tainted === true
  );
}

/** Add the sites named in owner messages of the run (its own owner text, steering rows). */
export function addOwnerTexts(ctx: HubContext, exec: RunExec, texts: string[]): void {
  for (const site of ownerSites(texts, ctx.deps.gate.domainOf)) exec.taint.sites.add(site);
}

/**
 * Whether a call of the run is decided as tainted: the run is tainted, or the call comes from a subagent (its
 * own tool results never reach the event stream, so its context is treated as untrusted).
 */
export function callTainted(exec: RunExec, call: { taskId?: string }): boolean {
  return exec.tainted || call.taskId !== undefined;
}

/** A main-thread tool call began: remember whether its result will taint the run. */
export function onTaintCall(exec: RunExec, toolUseId: string, tool: string): void {
  exec.taint.calls.set(toolUseId, taints(tool));
  if (tool === "WebSearch") exec.taint.searchCalls.add(toolUseId);
}

/**
 * A main-thread tool result came: a tainting one (or one of an unknown call) taints the run. The first one
 * stores `tainted` on the wake row with a fenced transition, so a resume of this run keeps it.
 */
export async function onTaintResult(
  ctx: HubContext,
  exec: RunExec,
  toolUseId: string,
  urls: string[] = [],
): Promise<void> {
  // The urls of a search result are the provider's, not text a page chose: a fetch of one is trusted.
  if (exec.taint.searchCalls.delete(toolUseId)) noteSearchUrls(exec.taint, urls);
  const tainting = exec.taint.calls.get(toolUseId) ?? true;
  exec.taint.calls.delete(toolUseId);
  if (!tainting || exec.tainted) return;
  exec.tainted = true;
  const { row } = exec;
  await ctx.deps.store.wakes.transition(row.id, row.leaseFence, ["running"], { tainted: true });
}

/**
 * A call of a tainted run was allowed: its site or MCP server needs no new taint card. Allowed by the policy
 * (a grant, no taint ask): noted when the call is decided as tainted. Allowed by the owner's answer on `card`
 * (one shot, answer in place): noted only when that card was asked while tainted, so an approval given in a
 * clean run never becomes a taint approval (the run may have become tainted since).
 */
export function noteAllowed(
  ctx: HubContext,
  exec: RunExec,
  call: Pick<ToolCall, "tool" | "input"> & { taskId?: string },
  card?: { approval?: { tainted?: boolean } },
): void {
  const taintApproval = card ? card.approval?.tainted === true : callTainted(exec, call);
  if (taintApproval) noteTaintAllowed(call, exec.taint, ctx.deps.gate.domainOf);
  // Used cleanly with no card: its arguments came from the owner's request. A card approved in a clean run stays no
  // taint approval (see above), so only a call the policy allowed counts.
  else if (!card) noteCleanServerUse(call, exec.taint);
}

/**
 * When the run starts: the sites in its own owner message (an owner-sent row only), and the sites and MCP
 * servers the owner approved on this run's earlier cards asked while tainted (a card asked in a clean run is
 * no taint approval). The card keeps the call's input redacted; a redacted url only fails to match (a new card).
 */
export async function seedTaint(ctx: HubContext, exec: RunExec): Promise<void> {
  if (exec.row.sender.kind === "user") addOwnerTexts(ctx, exec, [exec.row.text]);
  for (const card of await ctx.deps.store.cards.forWake(exec.row.id)) {
    const a = card.approval;
    const approved = card.answer === "once" || card.answer === "always";
    if (a?.tainted && approved && (card.status === "answered" || card.status === "used"))
      noteTaintAllowed({ tool: a.tool, input: a.input }, exec.taint, ctx.deps.gate.domainOf);
  }
}
