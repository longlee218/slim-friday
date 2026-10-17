/** Register a directory the owner named as a location of the thread's space and let this channel use it. */
export const REGISTER_LOCATION_TOOL = "RegisterLocation";

/** Limits of the `RegisterLocation` tool: defined orchestrator-side, re-exported here. */
export {
  PATH_MAX_CHARS,
  REGISTER_LOCATION_MAX_PER_RUN,
} from "../../../../orchestrator/lead/lead-limits";
