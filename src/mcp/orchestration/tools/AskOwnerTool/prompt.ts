import { OPTIONS_MAX, OPTIONS_MIN } from "./constants";

/** Description the model reads for the `AskOwner` tool. */
export const ASK_OWNER_DESCRIPTION =
  `Ask the owner one question; kind picks the control: yesno (Yes/No buttons), select (${OPTIONS_MIN}-${OPTIONS_MAX} ` +
  "options) or text (the owner types). One call per question. The answer is the tool result " +
  "(code TIMEOUT when nobody clicks in 10 minutes). Set workerAskId to relay a worker's pending question; the " +
  "answer then also goes to that worker. Keep questions few.";
