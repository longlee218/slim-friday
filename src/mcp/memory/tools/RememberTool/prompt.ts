/** Description the model reads for the `Remember` tool (the memory rule itself lives in AGENTS.md). */
export const REMEMBER_DESCRIPTION =
  "Save a durable note. When the owner asks you to remember something, call this in THIS turn; never say it is saved unless this tool returned saved. " +
  "scope: location = one location (give `location`); channel = this channel's topic (exists only in runs that have a channel); workspace = this project/team; journal = today's working notes (`kind: open` only here); " +
  "global = rare, goes to a review queue. kind: decision | fact | preference | lesson | open. One short plain sentence per note.";
