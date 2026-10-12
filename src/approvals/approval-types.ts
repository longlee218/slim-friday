/** A request for the owner to approve a tool call or plan. */
export interface ApprovalRequest {
  turnId: string;
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

/** A result message with Keep/Discard buttons that does not block the task (no answer = kept). */
export interface DecisionPost {
  turnId: string;
  threadId: string;
  /** Message text (the poster redacts and caps it). */
  content: string;
  /** File attached to the message (the patch), when small enough. */
  filePath?: string;
  /** Runs once on the owner's click (`keep` | `discard`); returns the line shown in place of the buttons. */
  onClick: (choice: "keep" | "discard") => Promise<string>;
}

/** Asks the owner for decisions. */
export interface ApprovalGateway {
  /** Post a Keep/Discard result message and return at once; false when it could not be sent. Absent in test fakes. */
  postDecision?(req: DecisionPost): Promise<boolean>;
  /** Show Approve/Deny buttons in the thread; resolve on owner click; timeout => denied "timeout". */
  request(req: ApprovalRequest): Promise<ApprovalResult>;
  /** Plan approval variant: Approve / Reject (reason "owner rejected plan" on reject). */
  requestPlan(req: ApprovalRequest): Promise<ApprovalResult>;
  /**
   * Typed owner feedback on the thread's open plan request: the same as Reject, with the text as the reason (the
   * planner revises and asks again). False when no plan request waits. Absent in test fakes.
   */
  feedbackPlan?(threadId: string, text: string): boolean;
  /** Like `request` with custom [approve, decline] labels; decline reason "owner declined". */
  confirm(req: ApprovalRequest, labels: [string, string]): Promise<ApprovalResult>;
  /** Drop every open request of a task (run aborted): buttons removed, decision "cancelled". */
  cancelTurn(turnId: string): void;
  /** AskUserQuestion: one button per option; resolve with chosen label, or undefined on timeout. */
  askChoice(a: {
    turnId: string;
    threadId: string;
    question: string;
    options: string[];
  }): Promise<string | undefined>;
}
