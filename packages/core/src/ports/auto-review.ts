/** Longest wait for an Auto Review verdict (spec §6.14); past it the call asks the owner. */
export const AUTO_REVIEW_TIMEOUT_MS = 10_000;

/** What the judge sees of one call (spec §6.14). */
export interface AutoReviewInput {
  /** The owner's words that started the chain, or the ticket text when no owner message started it. */
  ownerWords: string;
  /** False when `ownerWords` are not the owner's (a ticket text): they must not by themselves justify a pass. */
  ownerWordsAreOwner: boolean;
  /** The tool name of the call. */
  tool: string;
  /** The call's input (the adapter redacts secret keys and values before sending it). */
  input: Record<string, unknown>;
}

/** The judge's verdict: `pass` allows the call, `ask` shows the card with `reason` first. Never a deny. */
export interface AutoReviewVerdict {
  decision: "pass" | "ask";
  /** One short sentence; shown on the card and kept in the audit row. */
  reason: string;
}

/**
 * Auto Review (spec §6.14, R§16 step 4): a one-shot model judges whether a call the autonomy level would ask about
 * clearly fits what the owner asked. It never throws: errors and its timeout answer `ask` with the error as reason.
 */
export interface AutoReviewer {
  review(i: AutoReviewInput): Promise<AutoReviewVerdict>;
}
