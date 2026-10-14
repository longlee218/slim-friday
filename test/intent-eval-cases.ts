import type { TaskClass } from "../src/config/model-routing";
import type { RecentMessage } from "../src/intent/intent-types";
import type { ThreadState } from "../src/orchestrator/thread/thread-state";
import { CLASS_CASES } from "./intent-eval-cases-class";
import { CONVERSATION_CASES } from "./intent-eval-cases-conversation";
import { DESIGN_CASES } from "./intent-eval-cases-design";
import { DISCUSSION_CASES } from "./intent-eval-cases-discussion";
import { IDLE_CASES } from "./intent-eval-cases-idle";

/* Golden cases of the intent layer (data only; the runner is intent-eval.live.test.ts). */

/** What the thread looks like when the message arrives. */
export interface ThreadFacts {
  state: ThreadState;
  activeRole?: string;
  /** One line per earlier task (the classifier sees the last 3). */
  ledger?: string[];
  /** The thread has a task or a live clone (scope `active` is possible). Default: state is not idle/done. */
  hasTask?: boolean;
  /** Role of the thread's previous turn (L3 input `lastTurn`). */
  lastTurn?: { role: string };
}

/** What the layer must decide. A missing field is not scored. `ask` = low confidence (the owner is asked). */
export interface Expected {
  role?: "assistant" | "dev";
  scope?: "active" | "new";
  /**
   * Also accept `dev` WITH the `confirmDev` yes/no step (a plain dev start stays a miss). Only for a message that is
   * genuinely ambiguous: `confirmDev` is the designed safety net (owner decision 2026-10-12).
   */
  orDevConfirm?: true;
  cls?: TaskClass;
  ask?: true;
  /** The message answers the pending question: the decision must be this yes / no (a `gate-answer`). */
  pendingAnswer?: "yes" | "no";
  /** Injection-style text: any registry role or an owner question passes (never a crash / unknown role). */
  anyRegistryRoleOrAsk?: true;
}

/** One golden case. `codeRequest` = a clear change request: while idle it must NEVER reach a non-dev role. */
export interface GoldenCase {
  text: string;
  thread: ThreadFacts;
  expect: Expected;
  /** The last messages of the thread before this one (multi-turn cases), oldest first. Default: none. */
  recent?: RecentMessage[];
  /** The unanswered question the bot asked (queue / open-dev), for a pending-answer case. */
  pending?: string;
  codeRequest?: true;
  /** `holdout` = never used to tune the prompt; scored and reported apart. */
  group?: "holdout";
}

const LEDGER = ["dev: add isEmail helper to src/utils.ts (done, 1 commit)"];
const PLAN: ThreadFacts = {
  state: "running",
  activeRole: "dev",
  ledger: ["dev: round formatPrice to 2 decimals (plan waiting for approval)"],
};
const RUNNING: ThreadFacts = {
  state: "running",
  activeRole: "dev",
  ledger: ["dev: round formatPrice to 2 decimals (running)"],
};
// A finished task: the agent delivered it itself, so the thread is idle and every request is a new turn.
const RESULT: ThreadFacts = {
  state: "done",
  activeRole: "dev",
  ledger: ["dev: round formatPrice to 2 decimals (done)"],
};

export const GOLDEN: GoldenCase[] = [
  ...IDLE_CASES,
  ...CLASS_CASES,
  ...DISCUSSION_CASES,
  ...DESIGN_CASES,
  ...CONVERSATION_CASES,
  // Plan waiting for approval (an ask): feedback on the plan is dev/active; a question is the assistant; a separate request is new.
  {
    text: "Please also handle the null case in the plan.",
    thread: PLAN,
    expect: { role: "dev", scope: "active" },
  },
  {
    text: "Thêm bước viết test vào kế hoạch đi.",
    thread: PLAN,
    expect: { role: "dev", scope: "active" },
  },
  {
    text: "What does the plan mean by 'location: shop'?",
    thread: PLAN,
    expect: { role: "assistant" },
  },
  {
    text: "New request, unrelated to this plan: add a LICENSE file to the location.",
    thread: PLAN,
    expect: { role: "dev", scope: "new" },
  },
  // Running: steer (dev/active), side question (assistant), queued request (dev/new).
  {
    text: "Also make it work for negative prices.",
    thread: RUNNING,
    expect: { role: "dev", scope: "active" },
  },
  {
    text: "Chờ đã, đừng xử lý ngoại lệ nữa, chỉ cần log thôi.",
    thread: RUNNING,
    expect: { role: "dev", scope: "active" },
  },
  {
    text: "While that runs: where is slug defined?",
    thread: RUNNING,
    expect: { role: "assistant" },
  },
  {
    text: "After this one, rename slug to toSlug everywhere.",
    thread: RUNNING,
    expect: { role: "dev", scope: "new" },
  },
  // Task finished: questions (assistant), next task (dev/new).
  {
    text: "Thanks. Explain what you changed in two lines.",
    thread: RESULT,
    expect: { role: "assistant" },
  },
  { text: "Cho mình hỏi file nào bị sửa vậy?", thread: RESULT, expect: { role: "assistant" } },
  { text: "Why did the test fail in CI?", thread: RESULT, expect: { role: "assistant" } },
  {
    text: "Next task: add pagination to listOrders in src/orders.ts.",
    thread: RESULT,
    expect: { role: "dev", scope: "new" },
  },
];
