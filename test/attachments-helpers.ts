import { buildIntentUserPrompt } from "../src/intent/intent-prompt";

/** The classifier's user prompt for a message `text` in an idle thread. */
export const createIntentUserPrompt = (text: string): string =>
  buildIntentUserPrompt({ text, thread: { state: "idle" }, ledger: [], recent: [], roles: [] });
