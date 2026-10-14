import type { RecentMessage } from "../src/intent/intent-types";
import type { GoldenCase } from "./intent-eval-cases";

/*
 * Routing cases of an idle thread: a request to research / design / plan a FUTURE change goes to `dev`; a question,
 * opinion, pros/cons or research of how EXISTING code works stays `assistant` (outcome rule: answer now vs plan a
 * change). TUNING cases may be used while the prompt is tuned; HOLDOUT cases are run ONCE at the end and never used
 * to tune (anti-overfitting): their phrases are independent of the tuning ones and of the prompt examples.
 */

const IDLE = { state: "idle" } as const;
/** An idle thread whose previous turn was an assistant answer (multi-turn cases). */
const AFTER_ANSWER = { state: "idle", lastTurn: { role: "assistant" } } as const;

/** A research / design / planning wish: must reach `dev` as a new task (class is not scored). */
const toDev = (text: string, group?: "holdout", more: Partial<GoldenCase> = {}): GoldenCase => ({
  text,
  thread: IDLE,
  expect: { role: "dev", scope: "new" },
  ...more,
  ...(group && { group }),
});

/** A question, opinion, pros/cons or research of existing code, even about architecture: must stay `assistant`. */
const toAssistant = (
  text: string,
  group?: "holdout",
  more: Partial<GoldenCase> = {},
): GoldenCase => ({
  text,
  thread: IDLE,
  expect: { role: "assistant", scope: "new" },
  ...more,
  ...(group && { group }),
});

/** Two earlier messages (owner question, bot answer) for a multi-turn case. */
const talk = (q: string, a: string): { thread: GoldenCase["thread"]; recent: RecentMessage[] } => ({
  thread: AFTER_ANSWER,
  recent: [
    { from: "owner", text: q },
    { from: "bot", text: a },
  ],
});

export const DESIGN_CASES: GoldenCase[] = [
  // Tuning: wishes to research / design / plan a future change (dev)
  toDev(
    "tôi muốn nghiên cứu Friday trở thành dự án dạng config as agent khi các agent không cần phải hard code mà được cấu hình bằng file md",
  ),
  toDev(
    "tôi muốn nghiên cứu Friday trở thành dự án dạng config as agent, mọi role và skill đều khai báo bằng file md",
  ),
  toDev("I want to research making agents configurable by markdown files instead of hard-coded"),
  toDev("tôi muốn cải thiện kiến trúc phần hàng đợi, lên kế hoạch giúp tôi"),
  toDev("I want to improve the architecture of the intent layer, can you come up with a plan?"),
  // "Do not change anything yet" + an ask to plan: dev (it plans and waits for the owner's approval first).
  toDev(
    "đừng sửa gì vội, lên kế hoạch giúp tôi",
    undefined,
    talk(
      "retry của hàng đợi đang hoạt động ra sao?",
      "Hàng đợi thử lại 3 lần, xem src/queue.ts:40.",
    ),
  ),
  // Tuning: questions, opinions, research of EXISTING code (assistant)
  toAssistant("how does the intent layer pick a role?"),
  toAssistant("cơ chế stage engine hoạt động thế nào?"),
  toAssistant("what are the pros and cons of config-as-agent for this location?"),
  toAssistant("so sánh cách Friday định nghĩa role với cách khác"),
  toAssistant("kiến trúc Friday thế nào?"),
  toAssistant("nghiên cứu xem retry của billing chạy thế nào"),
  toAssistant("tôi muốn hiểu cơ chế stage engine"),
  // A wish worded as a question about pros/cons, on a FRESH thread (no earlier answer to confirm against).
  toAssistant("tôi muốn chuyển queue sang Redis, ưu nhược điểm?"),
  // Tuning: multi-turn. The assistant just explained the architecture; the owner now asks for a plan.
  toDev("ok, lập kế hoạch chuyển sang cấu hình bằng md đi", undefined, {
    ...talk(
      "kiến trúc role hiện tại của Friday như thế nào?",
      "Role là dữ liệu trong src/roles/builtin, một stage engine chung chạy chúng (src/orchestrator/engine).",
    ),
    // `confirmDev` may add a yes/no step; only the role is scored.
    expect: { role: "dev" },
  }),
  // Holdout: fresh wishes (VI + EN, one short "research X")
  toDev("nghiên cứu cách cho Friday tự quản lý skill theo từng workspace", "holdout"),
  toDev(
    "I'd like to redesign how roles are loaded so new ones need no code. Please plan it out.",
    "holdout",
  ),
  toDev("research a plugin system for the stage engine", "holdout"),
  // Holdout (adversarial): research of existing code, wish as a question, an idea (not a wish), pure questions
  toAssistant("research how the queue picks the next task", "holdout"),
  toAssistant("tìm hiểu giúp tôi cách Claude SDK xử lý session", "holdout"),
  toAssistant(
    "I'm thinking of switching the task store to Postgres, what would we gain and lose?",
    "holdout",
  ),
  toAssistant("tôi nghĩ nên chuyển sang config md", "holdout"),
  toAssistant("why is the stage engine split from the role registry?", "holdout"),
  toAssistant("điểm mạnh và điểm yếu của cách Friday lưu memory là gì?", "holdout"),
  // Holdout multi-turn: an objection (assistant) and a "so redo it" (dev) after an assistant answer.
  toAssistant("tại sao lại không dùng md?", "holdout", {
    ...talk(
      "role được định nghĩa ở đâu?",
      "Trong code TypeScript, src/roles/builtin/dev-role.ts:106.",
    ),
  }),
  toDev("vậy thiết kế lại đi", "holdout", {
    ...talk(
      "cách Friday nạp skill có ổn không?",
      "Skill nạp qua plugin của app, khá cứng: mỗi skill phải liệt kê trong role (src/roles/builtin/dev-role.ts:20).",
    ),
  }),
];
