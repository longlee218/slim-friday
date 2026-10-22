/** A request for the owner to approve a tool call. */
export interface ApprovalRequest {
  turnId: string;
  threadId: string;
  tool: string;
  /** Short one-line summary; gateway redacts it. */
  summary: string;
  /** Optional long text (full input/diff); sent as redacted .txt attachment, not inline. */
  detail?: string;
  /** Called after the request message was posted: it is then the first visible response (settles the receipt, stops typing). */
  onPosted?: () => void | Promise<void>;
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
    /** Show the two options as the localized approve/deny labels; the result is still the option text. */
    yesno?: boolean;
    /** Short card text when `question` is too long (the full question is attached). */
    stem?: string;
    /** Attachment name of a long question; absent = a generic name. */
    fileName?: string;
    /** Called with the Discord id of the posted question (a reply to that message can then be routed to its task). */
    onMessage?: (messageId: string) => void;
  }): Promise<string | undefined>;
}
