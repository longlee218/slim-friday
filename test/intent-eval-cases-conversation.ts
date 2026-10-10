import type { GoldenCase, ThreadFacts } from "./intent-eval-cases";

/* Multi-turn golden cases (P1.4e): the intent layer UNDERSTANDS the conversation. Each case carries the thread's
   `recent` messages (and a pending question when the bot asked one). No word lists are involved: replies that react
   to the previous turn continue it, a bare word answering a question names the role, a sentence that merely
   mentions "dev" stays a discussion, corrections win, yes / no are read against the pending question.
   `holdout` cases never tune the prompt: run them ONCE at the end (INTENT_EVAL_GROUP=holdout). */

const AFTER_CHAT: ThreadFacts = {
  state: "idle",
  ledger: [],
  lastTurn: { role: "assistant", kind: "qa" },
};
const AFTER_DEV: ThreadFacts = {
  state: "idle",
  ledger: ["dev: round formatPrice to 2 decimals (done, 1 commit)"],
  lastTurn: { role: "dev", kind: "exec" },
  hasTask: true,
};
const RUNNING: ThreadFacts = {
  state: "running",
  activeRole: "dev",
  activeStage: "exec",
  ledger: ["dev: round formatPrice to 2 decimals (running)"],
};

const CACHE_TALK = [
  { from: "owner" as const, text: "Có nên thêm cache cho bảng giá không?" },
  {
    from: "bot" as const,
    text: "Nên: cache 5 phút theo sản phẩm giảm tải DB đáng kể. Rủi ro: giá cũ khi vừa đổi giá (src/price.ts:42).",
  },
];
const REDIS_TALK = [
  { from: "owner" as const, text: "How should we cache the price table?" },
  {
    from: "bot" as const,
    text: "I suggest Redis with a 5 minute TTL per product, invalidated when a price changes.",
  },
];

export const CONVERSATION_CASES: GoldenCase[] = [
  // ---- Tuning set ----
  {
    // agreement after an assistant turn: still the conversation, no task
    text: "Ừ nghe hợp lý đấy.",
    thread: AFTER_CHAT,
    recent: CACHE_TALK,
    expect: { role: "assistant", scope: "new" },
  },
  {
    // objection after an assistant turn
    text: "I don't think Redis is worth it for a table this small.",
    thread: AFTER_CHAT,
    recent: REDIS_TALK,
    expect: { role: "assistant", scope: "new" },
  },
  {
    // a bare role word answering the bot's clarifying question
    text: "dev",
    thread: AFTER_CHAT,
    recent: [
      { from: "owner", text: "validate email trong form đăng ký" },
      { from: "bot", text: "Bạn muốn tôi giải thích cách làm hay sửa code luôn?" },
    ],
    expect: { role: "dev", scope: "new" },
    codeRequest: true,
  },
  {
    // a sentence that merely MENTIONS dev while discussing: stays the conversation
    text: "Tôi nghĩ team dev nên xem lại chỗ này trước khi mình quyết định, bạn thấy sao?",
    thread: AFTER_CHAT,
    recent: CACHE_TALK,
    expect: { role: "assistant", scope: "new" },
  },
  {
    // explicit leading tag (L1, no model call)
    text: "[dev] add a retry with backoff to fetchJson in src/http.ts",
    thread: AFTER_CHAT,
    recent: REDIS_TALK,
    expect: { role: "dev", scope: "new" },
    codeRequest: true,
  },
  {
    // correction: the owner meant a change, not an explanation
    text: "Không phải, ý tôi là hãy thêm cache vào hàm getPrice trong src/price.ts luôn.",
    thread: AFTER_CHAT,
    recent: [
      { from: "owner", text: "thêm cache cho bảng giá" },
      {
        from: "bot",
        text: "Cache là bộ nhớ tạm lưu kết quả để lần sau đọc nhanh hơn, thường có TTL.",
      },
    ],
    expect: { role: "dev", scope: "new" },
    codeRequest: true,
  },
  {
    // pending queue question, natural yes (Vietnamese)
    text: "okay đồng ý",
    thread: RUNNING,
    pending: 'A task is running. Run this after it? "rename slug to toSlug everywhere"',
    recent: [
      { from: "owner", text: "rename slug to toSlug everywhere" },
      {
        from: "bot",
        text: 'A task is running. Run this after it? Reply yes or no: "rename slug to toSlug everywhere"',
      },
    ],
    expect: { pendingAnswer: "yes" },
  },
  {
    // pending queue question, natural no (Vietnamese)
    text: "thôi để sau đi, chưa cần",
    thread: RUNNING,
    pending: 'A task is running. Run this after it? "rename slug to toSlug everywhere"',
    recent: [
      { from: "owner", text: "rename slug to toSlug everywhere" },
      {
        from: "bot",
        text: 'A task is running. Run this after it? Reply yes or no: "rename slug to toSlug everywhere"',
      },
    ],
    expect: { pendingAnswer: "no" },
  },
  {
    // "do that" after the assistant proposed something: a dev task; the brief gets the context
    text: "làm cái đó đi",
    thread: AFTER_CHAT,
    recent: [
      { from: "owner", text: "mình nên làm gì để giảm tải DB?" },
      {
        from: "bot",
        text: "Đề xuất: thêm cache 5 phút cho getPrice trong src/price.ts, xóa cache khi giá đổi.",
      },
    ],
    expect: { role: "dev", scope: "new" },
    codeRequest: true,
  },
  // ---- Holdout: run once at the end ----
  {
    text: "Makes sense, thanks.",
    thread: AFTER_CHAT,
    recent: REDIS_TALK,
    expect: { role: "assistant", scope: "new" },
    group: "holdout",
  },
  {
    text: "Mình không đồng ý, cache sẽ làm khách thấy giá cũ.",
    thread: AFTER_CHAT,
    recent: CACHE_TALK,
    expect: { role: "assistant", scope: "new" },
    group: "holdout",
  },
  {
    // the dev team is only mentioned in a question
    text: "The dev team keeps asking why we have two retry helpers. Do you know why?",
    thread: AFTER_CHAT,
    recent: [
      { from: "owner", text: "where is the retry logic?" },
      { from: "bot", text: "There are two: src/http.ts:12 and src/queue.ts:88." },
    ],
    expect: { role: "assistant", scope: "new" },
    group: "holdout",
  },
  {
    // correction the other way: the owner only wanted an explanation
    text: "No, I only wanted to know what that function does, don't change anything.",
    thread: AFTER_DEV,
    recent: [
      { from: "owner", text: "what does formatPrice do?" },
      { from: "bot", text: "Starting plan: round formatPrice to 2 decimals." },
    ],
    expect: { role: "assistant", scope: "new" },
    group: "holdout",
  },
  {
    // pending open-dev question, natural yes (English)
    text: "yeah go for it",
    thread: { state: "idle", ledger: [], lastTurn: { role: "assistant", kind: "qa" } },
    pending: 'Open a dev task for this? (yes/no) "add a cache layer to getPrice"',
    recent: [
      { from: "owner", text: "add a cache layer to getPrice" },
      { from: "bot", text: "Open a dev task for this? (yes/no)" },
    ],
    expect: { pendingAnswer: "yes" },
    group: "holdout",
  },
  {
    // pending open-dev question, natural no (English): not an answer to "yes", the owner wants the discussion
    text: "nah, just answer my question first",
    thread: { state: "idle", ledger: [], lastTurn: { role: "assistant", kind: "qa" } },
    pending: 'Open a dev task for this? (yes/no) "add a cache layer to getPrice"',
    recent: [
      { from: "owner", text: "add a cache layer to getPrice" },
      { from: "bot", text: "Open a dev task for this? (yes/no)" },
    ],
    expect: { pendingAnswer: "no" },
    group: "holdout",
  },
  {
    // picking an option the assistant listed = an instruction to implement it
    text: "Go with the second option, please implement it.",
    thread: AFTER_CHAT,
    recent: [
      { from: "owner", text: "how can we speed up listOrders?" },
      {
        from: "bot",
        text: "Two options: 1) add an index on orders.created_at, 2) paginate listOrders in src/orders.ts.",
      },
    ],
    expect: { role: "dev", scope: "new" },
    codeRequest: true,
    group: "holdout",
  },
];
