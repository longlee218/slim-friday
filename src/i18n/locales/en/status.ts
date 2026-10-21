/* `/status` (`status-copy.ts`). */
export const enStatus = {
  "status.progress": "Progress: {percent}%",
  "status.reported": "Reported: {note}",
  "status.lastActivity": "Last activity {ago} ago.",
  "status.nothing": "Nothing is running.",
  "status.tools": "{count} tools so far, latest:",
  "status.noTools": "No tools used yet.",
  "status.waitingTask": "Waiting task ({who}), stopped {ago} ago.",
  "status.scope": "Scope: {scope}",
  "status.running": "Running ({role}, {state}) for {ago}.",
  "status.approval": "Waiting for your approval of {tool} ({ago}).",
  "status.note": "Latest note: {note}",
} as const;
