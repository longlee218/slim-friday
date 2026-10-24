import { type RunStep, stepFromToolCall } from "../domain/run";

/** A finished (or still running) step, copied so callers never share the tracker's object. */
const copy = (s: RunStep): RunStep => ({ ...s });

/**
 * Tracks the steps of one session's turn: thinking, tool calls and background subagents.
 * Pure state: the pump shows each returned step and stores `take()` with the bot's text.
 */
export class RunTracker {
  /** Every step seen this turn, by id (a late tool_result or task_done finds its step here). */
  private steps = new Map<string, RunStep>();
  /** Ids of the steps since the last text, in order. */
  private pending: string[] = [];
  /** Background task id -> id of the step that shows it. */
  private taskSteps = new Map<string, string>();
  /** The open thinking step, if any. */
  private thinking?: RunStep;
  /** Counter for `think-<n>` ids. */
  private thinkCount = 0;

  /** Opens one thinking step, only when none is open. */
  onThinking(now: number): RunStep | undefined {
    if (this.thinking) return undefined;
    const step: RunStep = {
      id: `think-${++this.thinkCount}`,
      kind: "thinking",
      label: "Thinking",
      state: "running",
      startedAt: now,
    };
    this.thinking = step;
    this.add(step);
    return copy(step);
  }

  /** Closes the open thinking step `done`; undefined when none is open. */
  closeThinking(now: number): RunStep | undefined {
    const t = this.thinking;
    if (!t) return undefined;
    this.thinking = undefined;
    t.state = "done";
    t.endedAt = now;
    return copy(t);
  }

  /** Closes thinking (shown first) and adds the tool step. */
  onToolCall(e: { toolUseId: string; tool: string; input: Record<string, unknown> }, now: number) {
    const out: RunStep[] = [];
    const closed = this.closeThinking(now);
    if (closed) out.push(closed);
    const step = stepFromToolCall(e.toolUseId, e.tool, e.input, now);
    this.add(step);
    out.push(copy(step));
    return out;
  }

  /** Finishes a tool step; an unknown id changes nothing. */
  onToolResult(e: { toolUseId: string; ok: boolean }, now: number): RunStep | undefined {
    const step = this.steps.get(e.toolUseId);
    if (!step) return undefined;
    return this.finish(step, e.ok ? "done" : "failed", now);
  }

  /**
   * A background task started or ended. task_started carries the tool_use id of the Agent call: the task
   * owns that step (one line per subagent, right one with parallel subagents). Without a matching step
   * the task gets its own `task-<id>` step.
   */
  onTask(
    e:
      | { type: "task_started"; taskId: string; description: string; toolUseId?: string }
      | { type: "task_done"; taskId: string; status: "completed" | "failed" | "stopped" },
    now: number,
  ): RunStep | undefined {
    if (e.type === "task_started") {
      const known = e.toolUseId ? this.steps.get(e.toolUseId) : undefined;
      const step: RunStep = known ?? {
        id: `task-${e.taskId}`,
        kind: "subagent",
        label: "Started subagent",
        state: "running",
        startedAt: now,
      };
      if (e.description) step.target = e.description;
      if (!known) this.add(step);
      this.taskSteps.set(e.taskId, step.id);
      return copy(step);
    }
    const id = this.taskSteps.get(e.taskId);
    const step = id ? this.steps.get(id) : undefined;
    this.taskSteps.delete(e.taskId);
    // A stopped task is not a failure.
    return step ? this.finish(step, e.status === "failed" ? "failed" : "done", now) : undefined;
  }

  /** The steps since the last text, cleared; an open thinking step is closed `done` first. */
  take(now = 0): RunStep[] {
    this.closeThinking(now);
    const out = this.pending.flatMap((id) => {
      const s = this.steps.get(id);
      return s ? [copy(s)] : [];
    });
    this.pending = [];
    return out;
  }

  /** End of turn: closes thinking (returned, to be shown) and forgets everything. */
  endTurn(now: number): RunStep | undefined {
    const closed = this.closeThinking(now);
    this.steps.clear();
    this.pending = [];
    this.taskSteps.clear();
    return closed;
  }

  private add(step: RunStep): void {
    this.steps.set(step.id, step);
    this.pending.push(step.id);
  }

  private finish(step: RunStep, state: "done" | "failed", now: number): RunStep {
    step.state = state;
    step.endedAt = now;
    return copy(step);
  }
}
