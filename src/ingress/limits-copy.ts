import { ROLES } from "../roles/role-registry";
import { SUBAGENT_CAPABILITIES } from "../tools/tool-catalog";
import type { OwnerLanguage } from "./user-copy";

/* Owner text of `/limits` (vi / en), rendered by app code, no model. Every number comes from the collected limits
   (`collectLimits`) or the role registry at call time; this file holds only labels and which constant goes in which
   section. A collected limit that no section names still shows up under "other", so none is ever hidden. */

/** Constant names per section (the section title is wording, the names are the code's own). */
export const LIMIT_GROUPS = {
  pools: [
    "LEAD_POOL_MAX",
    "LEAD_WAITING_MAX",
    "WORKER_POOL_MAX",
    "MAX_RUNNING_PER_THREAD",
    "WORKER_SLOT_NOTICE_MS",
    "WORKER_SLOT_RETRY_MS",
    "LEAD_QUEUE_PER_THREAD",
    "LEAD_DEBOUNCE_MS",
  ],
  budgets: ["TASK_BUDGET_USD", "GOAL_BUDGET_USD", "MIN_RECOVERY_BUDGET_USD"],
  stops: [
    "ITEM_MAX_AGE_MS",
    "STALE_AFTER_MS",
    "SWEEP_TICK_MS",
    "ACTIVITY_PERSIST_MS",
    "AUTO_RESUME_CAP",
    "RESUME_BACKOFF_STEP_MS",
    "MAX_DISPATCHES_PER_ITEM",
    "DIGEST_FLOOR_MS",
    "HOLD_ESCALATE_MS",
    "MAX_ESCALATIONS_PER_TICK",
    "MAX_FIX_LOOPS",
    "RELAY_WAIT_MS",
    "ASK_OWNER_TIMEOUT_MS",
    "PENDING_PLAN_MAX_AGE_MS",
    "PLAN_MAX_ITEMS",
    "PLAN_MAX_CRITERIA",
    "PLAN_MAX_REVISIONS",
    "CHAIN_CAP",
    "DELEGATE_MAX",
    "DISPATCHES_PER_RUN",
  ],
} as const;

/** Live counters of the process (from the limiters and the db), read at the moment of the command. */
export interface LiveState {
  leadUsed: number;
  leadWaiting: number;
  workerUsed: number;
  /** Ready items kept waiting by a full worker pool. */
  readyWaiting: number;
  /** Items running per thread (threads with none are not listed). */
  running: { threadId: string; count: number }[];
}

/** `/limits [role]` text builder given to the Discord ingress (index.ts wires it). */
export type LimitsView = (role: string | undefined, language: OwnerLanguage) => Promise<LimitsText>;

/** The reply: `text` is everything; `head` (pools + live state) is what fits the message body when `text` is long. */
export interface LimitsText {
  text: string;
  head: string;
}

/** Threads listed in the live state; the rest is "+N more". */
export const LIVE_THREADS_MAX = 10;

/** Milliseconds as "800ms" / "3s" / "15min" / "8h". */
function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const units: [number, string][] = [
    [3_600_000, "h"],
    [60_000, "min"],
    [1000, "s"],
  ];
  const [size, unit] = units.find(([s]) => ms >= s) ?? [1000, "s"];
  return `${Math.round((ms / size) * 100) / 100}${unit}`;
}

/** A limit value with the unit its name carries (`_MS` time, `_USD` dollars, else the plain number). */
function show(name: string, v: number): string {
  if (name.endsWith("_MS")) return duration(v);
  if (name.endsWith("_USD")) return `$${v}`;
  return String(v);
}

/** Roles as shown: the filter (one role) or all, in registry order. */
const rolesOf = (filter?: string) =>
  Object.values(ROLES).filter((r) => !filter || r.name === filter);

/** One line per role: model, turns, budget, asks, subagents (values read from the collected map). */
function roleLine(limits: ReadonlyMap<string, number>, name: string): string {
  const get = (k: string) => limits.get(`role.${name}.${k}`) ?? 0;
  const model = ROLES[name]?.model ?? "?";
  const subs = get("subagents.enabled")
    ? `subagents on (parallel ${get("subagents.parallel")}, depth ${get("subagents.depth")})`
    : "subagents off";
  return `- ${name} (${model}): maxTurns ${get("maxTurns")}, budgetUsd ${show("_USD", get("budgetUsd"))}, maxAsk ${get("maxAsk")}, ${subs}`;
}

/**
 * The `/limits` reply. Without `role`: pools, every role, budgets, stop conditions, subagent allowlist, anything else
 * collected, live state. With `role`: that role only (or a one-line unknown-role notice).
 */
export function renderLimits(
  limits: ReadonlyMap<string, number>,
  opts: { role?: string; live: LiveState; language: OwnerLanguage },
): LimitsText {
  const say = (vi: string, en: string) => (opts.language === "vi" ? vi : en);
  const lines = (names: readonly string[]) =>
    names.filter((n) => limits.has(n)).map((n) => `- ${n}: ${show(n, limits.get(n) ?? 0)}`);
  const roleLines = rolesOf(opts.role).map((r) => roleLine(limits, r.name));
  if (opts.role) {
    const text = roleLines.length
      ? [say(`Giới hạn của ${opts.role}:`, `Limits of ${opts.role}:`), ...roleLines].join("\n")
      : say(`Không có vai trò ${opts.role}.`, `Unknown role: ${opts.role}.`);
    return { text, head: text };
  }
  const grouped = new Set<string>(Object.values(LIMIT_GROUPS).flat());
  const other = [...limits.keys()].filter((k) => !k.startsWith("role.") && !grouped.has(k));
  const poolLines = [say("**Pool**", "**Pools**"), ...lines(LIMIT_GROUPS.pools)];
  const liveLines = liveSection(limits, opts.live, say);
  const text = [
    ...poolLines,
    say("**Vai trò**", "**Roles**"),
    ...roleLines,
    say("**Ngân sách**", "**Budgets**"),
    ...lines(LIMIT_GROUPS.budgets),
    say("- Không có giới hạn theo ngày.", "- No daily cap."),
    say("**Điều kiện dừng**", "**Stop conditions**"),
    ...lines(LIMIT_GROUPS.stops),
    say("- Không có timeout cho run: chỉ /stop.", "- No run timeout: /stop only."),
    say("**Subagent được dùng**", "**Subagent allowlist**"),
    `- ${SUBAGENT_CAPABILITIES.join(", ")}`,
    ...(other.length ? [say("**Khác**", "**Other**"), ...lines(other)] : []),
    ...liveLines,
  ].join("\n");
  return { text, head: [...poolLines, ...liveLines].join("\n") };
}

/** Live state lines: slots used of each pool, waiting counts, and the busiest threads (capped, as channel mentions). */
function liveSection(
  limits: ReadonlyMap<string, number>,
  live: LiveState,
  say: (vi: string, en: string) => string,
): string[] {
  const cap = (k: string) => limits.get(k) ?? "?";
  const shown = live.running.slice(0, LIVE_THREADS_MAX);
  const more = live.running.length - shown.length;
  return [
    say("**Trạng thái hiện tại**", "**Live state**"),
    say(
      `- Lead pool: ${live.leadUsed}/${cap("LEAD_POOL_MAX")} đang dùng, ${live.leadWaiting} thread đang chờ`,
      `- Lead pool: ${live.leadUsed}/${cap("LEAD_POOL_MAX")} used, ${live.leadWaiting} threads waiting`,
    ),
    say(
      `- Worker slot: ${live.workerUsed}/${cap("WORKER_POOL_MAX")} đang dùng`,
      `- Worker slots: ${live.workerUsed}/${cap("WORKER_POOL_MAX")} used`,
    ),
    say(
      `- Việc ready đang chờ slot: ${live.readyWaiting}`,
      `- Ready items waiting for a slot: ${live.readyWaiting}`,
    ),
    ...(shown.length
      ? shown.map((r) =>
          say(`- <#${r.threadId}>: ${r.count} việc`, `- <#${r.threadId}>: ${r.count} running`),
        )
      : [say("- Không có việc nào đang chạy.", "- No item running.")]),
    ...(more > 0 ? [say(`- +${more} thread nữa`, `- +${more} more threads`)] : []),
  ];
}
