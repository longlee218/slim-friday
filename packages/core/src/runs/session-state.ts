/** A part of the session state a bot is shown (and can go stale in a resumed session). */
export type StatePart =
  | "rules"
  | "memory"
  | "groupContext"
  | "groupRules"
  | "groupMemory"
  | "teammates"
  | "scratchpad";

/** Hash of each state part as last shown to a session; a missing part was never shown. */
export type SessionStateHashes = Partial<Record<StatePart, string>>;
