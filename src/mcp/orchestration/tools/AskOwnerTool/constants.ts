/** Ask the owner a question with buttons; the answer comes back as the tool result. */
export const ASK_OWNER_TOOL = "AskOwner";

/** Limits of the `AskOwner` tool: defined orchestrator-side, re-exported here. */
export {
  ASK_OWNER_TIMEOUT_MS,
  OPTION_MAX_CHARS,
  OPTIONS_MAX,
  OPTIONS_MIN,
  QUESTION_MAX_CHARS,
} from "../../../../orchestrator/engine/lead-limits";
