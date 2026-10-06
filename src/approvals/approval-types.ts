/** A request for the owner to approve a tool call or plan. */
export interface ApprovalRequest {
  taskId: string;
  threadId: string;
  tool: string;
  /** Short one-line summary; gateway redacts it. */
  summary: string;
  /** Optional long text (full input/diff/plan); sent as redacted .txt attachment, not inline. */
  detail?: string;
}

/** Owner's decision. */
export interface ApprovalResult {
  approved: boolean;
  /** Why denied: "timeout" | "owner denied" | "no channel" | feedback text. */
  reason?: string;
}

/** Asks the owner for decisions. */
export interface ApprovalGateway {
  /** Show Approve/Deny buttons in the thread; resolve on owner click; timeout => denied "timeout". */
  request(req: ApprovalRequest): Promise<ApprovalResult>;
  /** Plan approval variant: Approve / Reject (reason "owner rejected plan" on reject). */
  requestPlan(req: ApprovalRequest): Promise<ApprovalResult>;
  /** Like `request` with custom [approve, decline] labels; decline reason "owner declined". */
  confirm(req: ApprovalRequest, labels: [string, string]): Promise<ApprovalResult>;
  /** Drop every open request of a task (run aborted): buttons removed, decision "cancelled". */
  cancelTask(taskId: string): void;
  /** AskUserQuestion: one button per option; resolve with chosen label, or undefined on timeout. */
  askChoice(a: {
    taskId: string;
    threadId: string;
    question: string;
    options: string[];
  }): Promise<string | undefined>;
}
