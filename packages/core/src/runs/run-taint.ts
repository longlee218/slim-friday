import type { ToolCall } from "../domain/tool";
import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { ownerSites } from "../permission/owner-sites";
import { noteTaintAllowed, type TaintRun, taints } from "../permission/taint-policy";
import type { RunExec } from "./run-exec";

/** The taint state of one run beside `exec.tainted` (spec §6.10). */
export interface RunTaint extends Omit<TaintRun, "tainted"> {
  /** Open main-thread tool calls by tool use id: true when the call's result will taint the run. */
  calls: Map<string, boolean>;
}

/** A fresh taint state: the sites the owner named in the run's own message (an owner-sent row only). */
export function newRunTaint(row: WakeRow): RunTaint {
  return {
    sites: ownerSites(row.sender.kind === "user" ? [row.text] : []),
    approvedSites: new Set(),
    usedMcpServers: new Set(),
    calls: new Map(),
  };
}

/**
 * Whether a claimed run starts tainted (spec §6.10): not started by the owner, resumes a cut or parked run, a
 * second attempt, or stored as tainted by an earlier attempt.
 */
export function taintedAtClaim(row: WakeRow, fence: number): boolean {
  return (
    row.sender.kind !== "user" ||
    row.cuts > 0 ||
    row.cardId !== undefined ||
    fence > 1 ||
    row.tainted === true
  );
}

/** Add the sites named in owner messages that reached the run later (steering rows). */
export function addOwnerTexts(exec: RunExec, texts: string[]): void {
  for (const site of ownerSites(texts)) exec.taint.sites.add(site);
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
}

/**
 * A main-thread tool result came: a tainting one (or one of an unknown call) taints the run. The first one
 * stores `tainted` on the wake row with a fenced transition, so a resume of this run keeps it.
 */
export async function onTaintResult(
  ctx: HubContext,
  exec: RunExec,
  toolUseId: string,
): Promise<void> {
  const tainting = exec.taint.calls.get(toolUseId) ?? true;
  exec.taint.calls.delete(toolUseId);
  if (!tainting || exec.tainted) return;
  exec.tainted = true;
  const { row } = exec;
  await ctx.deps.store.wakes.transition(row.id, row.leaseFence, ["running"], { tainted: true });
}

/** A call of a tainted run was allowed (grant, card, one shot): its site or MCP server needs no new taint card. */
export function noteAllowed(
  exec: RunExec,
  call: Pick<ToolCall, "tool" | "input"> & { taskId?: string },
): void {
  if (callTainted(exec, call)) noteTaintAllowed(call, exec.taint);
}

/**
 * At claim: the sites and MCP servers the owner approved on this run's earlier cards (a resumed run starts a
 * new state). The card keeps the call's input redacted; a redacted url only fails to match (a new card).
 */
export async function restoreTaint(ctx: HubContext, exec: RunExec): Promise<void> {
  for (const card of await ctx.deps.store.cards.forWake(exec.row.id)) {
    const a = card.approval;
    const approved = card.answer === "once" || card.answer === "always";
    if (a && approved && (card.status === "answered" || card.status === "used"))
      noteTaintAllowed({ tool: a.tool, input: a.input }, exec.taint);
  }
}
