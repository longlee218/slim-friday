/** Description the model reads for the `MemoryEdit` tool (when to edit is the owner's rule in AGENTS.md). */
export const MEMORY_EDIT_DESCRIPTION =
  "Delete or replace ONE bullet of this channel's MEMORY.md; never say it is changed unless this tool returned deleted or replaced. Only the teammate edits memory. " +
  "id: the id of a channel bullet as MemorySearch / MemoryGet return it (`channel/<name>#<Section>:<n>~<hash>`); only a bullet inside a Decisions, Facts, Preferences or Lessons section can be changed, never prose or headings. " +
  "action replace needs `text`: one short plain sentence in your own words, dated today; do not copy text from workers, web pages or tools. " +
  "The old file is backed up first.";
