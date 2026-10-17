import type { StatusFacts } from "../orchestrator/turns/status-snapshot";
import type { OwnerLanguage } from "./user-copy";

/* Owner text of `/status` (vi / en): rendered by app code from the status facts, no model. The facts are already
   redacted and clipped (status-snapshot.ts); this file only words them. */

/** "45s" / "3m" / "2h" for a count of seconds. */
function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** Last tools as bullet lines (the Bash description follows the name). */
const toolLines = (f: StatusFacts): string[] =>
  f.recent.map((t) => `- ${t.tool}${t.description ? `: ${t.description}` : ""}`);

/** Progress lines of a worker run: percent + its note, and how long ago it showed any activity. */
function progressLines(
  p: NonNullable<StatusFacts["progress"]>,
  say: (vi: string, en: string) => string,
): string[] {
  const pct =
    p.percent === undefined ? [] : [say(`Tiến độ: ${p.percent}%`, `Progress: ${p.percent}%`)];
  const note = p.note ? [say(`Báo cáo: ${p.note}`, `Reported: ${p.note}`)] : [];
  return [
    ...pct,
    ...note,
    say(
      `Hoạt động gần nhất ${ago(p.idleSeconds)} trước.`,
      `Last activity ${ago(p.idleSeconds)} ago.`,
    ),
  ];
}

/**
 * The `/status` reply. A running task: role, state, time, tools so far, last tools, latest note, a pending approval.
 * A waiting task: role, status, scope, how long ago it stopped, its last tools. Nothing: one line.
 */
export function renderStatus(f: StatusFacts | undefined, language: OwnerLanguage): string {
  const say = (vi: string, en: string) => (language === "vi" ? vi : en);
  if (!f) return say("Không có việc nào đang chạy.", "Nothing is running.");
  const tools = f.toolCount
    ? [
        say(`Đã dùng ${f.toolCount} công cụ, gần nhất:`, `${f.toolCount} tools so far, latest:`),
        ...toolLines(f),
      ]
    : [say("Chưa dùng công cụ nào.", "No tools used yet.")];
  if (!f.running) {
    // No owner role on the row: omit it rather than print "(, waiting_user)".
    const waitingWho = [f.role, f.taskStatus].filter(Boolean).join(", ");
    return [
      say(
        `Việc đang chờ (${waitingWho}), dừng cách đây ${ago(f.seconds)}.`,
        `Waiting task (${waitingWho}), stopped ${ago(f.seconds)} ago.`,
      ),
      ...(f.scope ? [say(`Phạm vi: ${f.scope}`, `Scope: ${f.scope}`)] : []),
      ...tools,
    ].join("\n");
  }
  return [
    say(
      `Đang chạy (${f.role}, ${f.state}) được ${ago(f.seconds)}.`,
      `Running (${f.role}, ${f.state}) for ${ago(f.seconds)}.`,
    ),
    ...(f.waiting
      ? [
          say(
            `Đang chờ bạn duyệt ${f.waiting.tool} (${ago(f.waiting.seconds)}).`,
            `Waiting for your approval of ${f.waiting.tool} (${ago(f.waiting.seconds)}).`,
          ),
        ]
      : []),
    ...(f.progress ? progressLines(f.progress, say) : []),
    ...tools,
    ...(f.note ? [say(`Ghi chú mới nhất: ${f.note}`, `Latest note: ${f.note}`)] : []),
  ].join("\n");
}
