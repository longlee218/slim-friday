import type { OwnerLanguage } from "../i18n/languages";
import { t } from "../i18n/translate";
import type { StatusFacts } from "../orchestrator/turns/status-snapshot";

/* Owner text of `/status` (every language of the list): rendered by app code from the status facts, no model. The facts are already
   redacted and clipped (status-snapshot.ts); this file only words them. */

/** "45s" / "3m" / "2h" for a count of seconds. */
function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/** Last tools as bullet lines (the Bash description follows the name). */
const toolLines = (f: StatusFacts): string[] =>
  f.recent.map((t) => `- ${t.tool}${t.description ? `: ${t.description}` : ""}`);

/** Progress lines of a worker run: percent + its note, and how long ago it showed any activity. */
function progressLines(p: NonNullable<StatusFacts["progress"]>, language: OwnerLanguage): string[] {
  return [
    ...(p.percent === undefined ? [] : [t(language, "status.progress", { percent: p.percent })]),
    ...(p.note ? [t(language, "status.reported", { note: p.note })] : []),
    t(language, "status.lastActivity", { ago: ago(p.idleSeconds) }),
  ];
}

/**
 * The `/status` reply. A running task: role, state, time, tools so far, last tools, latest note, a pending approval.
 * A waiting task: role, status, scope, how long ago it stopped, its last tools. Nothing: one line.
 */
export function renderStatus(f: StatusFacts | undefined, language: OwnerLanguage): string {
  if (!f) return t(language, "status.nothing");
  const tools = f.toolCount
    ? [t(language, "status.tools", { count: f.toolCount }), ...toolLines(f)]
    : [t(language, "status.noTools")];
  if (!f.running) {
    // No owner role on the row: omit it rather than print "(, waiting_user)".
    const who = [f.role, f.taskStatus].filter(Boolean).join(", ");
    return [
      t(language, "status.waitingTask", { who, ago: ago(f.seconds) }),
      ...(f.scope ? [t(language, "status.scope", { scope: f.scope })] : []),
      ...tools,
    ].join("\n");
  }
  return [
    t(language, "status.running", {
      role: f.role ?? "",
      state: f.state ?? "",
      ago: ago(f.seconds),
    }),
    ...(f.waiting
      ? [t(language, "status.approval", { tool: f.waiting.tool, ago: ago(f.waiting.seconds) })]
      : []),
    ...(f.progress ? progressLines(f.progress, language) : []),
    ...tools,
    ...(f.note ? [t(language, "status.note", { note: f.note })] : []),
  ].join("\n");
}
