/** Description the model reads for the `MemorySave` tool (when to save is the owner's rule in AGENTS.md). */
export const MEMORY_SAVE_DESCRIPTION =
  "Save a durable note; never say it is saved unless this tool returned saved. Only the lead saves memory; members only read it. " +
  "scope: channel = this channel's MEMORY.md, read by the lead and every member of the channel (exists only in runs that have a channel); journal = today's working notes of this channel (`kind: open` only here; needs a channel too). " +
  "kind: decision | fact | preference | lesson | open. Stored as one plain line; no task-specific details.";
