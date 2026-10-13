import type { GoldenCase } from "./intent-eval-cases";

/*
 * Class-rubric cases of an idle thread (mechanical / standard / design; English + Vietnamese). TUNING cases may be
 * used while the prompt is tuned; HOLDOUT cases are run once at the end and never used to tune (anti-overfitting).
 */

const IDLE = { state: "idle" } as const;
const mk = (
  text: string,
  cls: "mechanical" | "standard" | "design",
  group?: "holdout",
): GoldenCase => ({
  text,
  thread: IDLE,
  expect: { role: "dev", scope: "new", cls },
  codeRequest: true,
  ...(group && { group }),
});

/** An answering request (assistant): the class picks its model tier (P11: mechanical/standard haiku, design sonnet). */
const ask = (
  text: string,
  cls: "mechanical" | "standard" | "design",
  group?: "holdout",
): GoldenCase => ({
  text,
  thread: IDLE,
  expect: { role: "assistant", scope: "new", cls },
  ...(group && { group }),
});

export const CLASS_CASES: GoldenCase[] = [
  // Tuning
  mk("Change the default page size constant from 20 to 25.", "mechanical"),
  mk("Đổi tên biến tmp thành retryCount trong src/queue.ts.", "mechanical"),
  mk("Fix the typo in the comment above parseDate.", "mechanical"),
  mk("Reformat src/config.ts with the project formatter.", "mechanical"),
  mk("Write tests covering the coupon expiry logic.", "standard"),
  mk("Viết thêm test cho hàm parseDate.", "standard"),
  mk("The cart crashes when the list is empty, please fix it.", "standard"),
  mk("Thêm endpoint GET /orders/:id trả về đơn hàng.", "standard"),
  mk("Propose a caching strategy for the whole API and implement it.", "design"),
  mk("Thiết kế lại kiến trúc thông báo để hỗ trợ nhiều kênh.", "design"),
  mk("Redo the dashboard UX so first-time users onboard faster.", "design"),
  mk(
    "Move billing, orders and inventory into separate packages and design the new module boundaries.",
    "design",
  ),
  // Holdout
  mk("Remove the trailing whitespace in docs/setup.md.", "mechanical", "holdout"),
  mk("Đổi timeout mặc định từ 5 giây thành 10 giây trong config.", "mechanical", "holdout"),
  mk("Rename the helper getUsr to getUser across the repo.", "mechanical", "holdout"),
  mk("Add input validation to the signup form handler.", "standard", "holdout"),
  mk("Hàm tính thuế trả về sai khi giá bằng 0, sửa lại đi.", "standard", "holdout"),
  mk("Please write a test for the retry logic in src/http.ts.", "standard", "holdout"),
  mk("Implement a function that slugifies product titles.", "standard", "holdout"),
  mk(
    "Rethink our authentication strategy: evaluate OAuth vs sessions and migrate.",
    "design",
    "holdout",
  ),
  mk("Thiết kế hệ thống phân quyền theo vai trò cho toàn bộ ứng dụng.", "design", "holdout"),
  mk("Redesign the checkout flow UI and UX.", "design", "holdout"),
  // Answering requests (assistant): tuning
  ask("Xin chào!", "mechanical"),
  ask("What port does the dev server listen on?", "mechanical"),
  ask("Explain how the retry queue works in this repo.", "standard"),
  ask("Tóm tắt giúp tôi file README của dự án.", "standard"),
  ask(
    "Compare how billing, orders and inventory share state and where the module boundaries leak.",
    "design",
  ),
  ask("Phân tích kiến trúc thông báo hiện tại và so sánh các hướng mở rộng nhiều kênh.", "design"),
  // Answering requests (assistant): holdout
  ask("Thanks, good morning!", "mechanical", "holdout"),
  ask("Where is the default page size defined?", "mechanical", "holdout"),
  ask("Giải thích hàm parseDate làm gì.", "standard", "holdout"),
  ask("Summarize what changed in the last three commits.", "standard", "holdout"),
  ask(
    "Walk through how a request flows across the API, queue and worker, and compare it with an event-driven design.",
    "design",
    "holdout",
  ),
  ask(
    "Đánh giá toàn bộ cách các module auth, session và permission phụ thuộc nhau.",
    "design",
    "holdout",
  ),
];
