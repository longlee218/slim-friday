/** Split an optional `task:` prefix (code task, plan mode + approvals) off a message. */
export function parseTaskPrefix(text: string): { code: boolean; text: string } {
  const m = /^task:\s*/i.exec(text.trim());
  return m ? { code: true, text: text.trim().slice(m[0].length) } : { code: false, text };
}
