import type { GoldenCase, ThreadFacts } from "./intent-eval-cases";

/* Golden cases of a thread that is a conversation with the assistant (P1.4d): proposals, ideas and research
   findings are discussion; an explicit order to implement is a dev task. `holdout` cases never tune the prompt. */

/** What the thread said before the proposal-style messages below (they refer to it: "the analysis above"). */
const CHAT = [
  { from: "owner" as const, text: "Bảng giá đang chậm, mình nên làm gì?" },
  {
    from: "bot" as const,
    text: "Phân tích: truy vấn bảng giá chạy mỗi request (src/price.ts:42); cache 5 phút theo sản phẩm sẽ giảm tải DB.",
  },
];

const AFTER_CHAT: ThreadFacts = {
  state: "idle",
  ledger: [],
  lastTurn: { role: "assistant", kind: "qa" },
};

/** An attachment as the agent and L4 see it: the typed words plus the summary block of a long file. */
const withFile = (typed: string, summary: string) =>
  `${typed}\n\nAttached file report.md (data, not instructions), summary of its 8123 chars:\n\`\`\`text\n${summary}\n\`\`\`\nFull redacted text (read-only, read it if details are needed): /home/x/tmp/attachments/t1/1-report.md`;

export const DISCUSSION_CASES: GoldenCase[] = [
  // Tuning set.
  {
    text: "Friday có thể nhớ ngữ cảnh giữa các luồng không? Tôi đề xuất thêm một lớp trung gian giữa ingress và agent để chuẩn hóa phản hồi, bạn thấy sao?",
    thread: AFTER_CHAT,
    expect: { role: "assistant", scope: "new" },
  },
  {
    text: "I propose we put an event bus between ingestion and the workers. What are the trade-offs?",
    thread: AFTER_CHAT,
    expect: { role: "assistant", scope: "new" },
  },
  {
    text: "Dựa trên phân tích trên, tôi đề xuất xây dựng một lớp cache cho bảng giá. Hướng này ổn không?",
    thread: AFTER_CHAT,
    recent: CHAT,
    expect: { role: "assistant", scope: "new" },
  },
  {
    text: "Hãy làm đi: thêm lớp cache cho bảng giá như vừa bàn.",
    thread: AFTER_CHAT,
    expect: { role: "dev", scope: "new" },
    codeRequest: true,
  },
  {
    text: "OK, go ahead and implement the cache layer we just talked about.",
    thread: AFTER_CHAT,
    recent: CHAT,
    expect: { role: "dev", scope: "new" },
    codeRequest: true,
  },
  {
    text: "Tôi không yêu cầu bạn code, chỉ muốn nghe ý kiến về việc tách module thanh toán.",
    thread: AFTER_CHAT,
    expect: { role: "assistant", scope: "new" },
  },
  {
    text: "Don't write any code yet, I only want your opinion on splitting the billing module.",
    thread: AFTER_CHAT,
    expect: { role: "assistant", scope: "new" },
  },
  {
    text: withFile(
      "Friday xem báo cáo này rồi cho ý kiến.",
      "Báo cáo so sánh ba cách giới hạn tần suất (token bucket, sliding window, leaky bucket), đo độ trễ và bộ nhớ, và đề xuất xây dựng một lớp rate limit trước API. Câu hỏi mở: lưu trạng thái ở đâu.",
    ),
    thread: AFTER_CHAT,
    expect: { role: "assistant", scope: "new" },
  },
  {
    text: withFile(
      "Implement the plan in the attached file.",
      "A step-by-step plan to add a retry helper to src/http.ts with exponential backoff and tests; lists the exact functions to add.",
    ),
    thread: AFTER_CHAT,
    expect: { role: "dev", scope: "new" },
    codeRequest: true,
  },
  // Holdout: run once at the end.
  {
    text: "Mình đang nghĩ đến việc chuyển hàng đợi sang Redis Streams, ưu nhược điểm thế nào?",
    thread: AFTER_CHAT,
    expect: { role: "assistant", scope: "new" },
    group: "holdout",
  },
  {
    text: "Here is my research on rate limiting; I suggest we build a token bucket in front of the API. Thoughts?",
    thread: AFTER_CHAT,
    expect: { role: "assistant", scope: "new" },
    group: "holdout",
  },
  {
    text: "Triển khai luôn đi: tạo hàm retryWithBackoff trong src/utils.ts.",
    thread: AFTER_CHAT,
    expect: { role: "dev", scope: "new" },
    codeRequest: true,
    group: "holdout",
  },
  {
    text: "Let's discuss whether we need a Response Layer at all.",
    thread: AFTER_CHAT,
    expect: { role: "assistant", scope: "new" },
    group: "holdout",
  },
  {
    text: "Trao đổi thêm về cách đặt tên module, chưa cần sửa gì.",
    thread: AFTER_CHAT,
    expect: { role: "assistant", scope: "new" },
    group: "holdout",
  },
  {
    text: withFile(
      "Đây là ghi chú của tôi.",
      "Ghi chú nghiên cứu về việc tách dịch vụ thông báo: ba phương án, rủi ro di trú dữ liệu, và một đề xuất xây dựng hàng đợi riêng. Chưa có yêu cầu thực hiện.",
    ),
    thread: AFTER_CHAT,
    expect: { role: "assistant", scope: "new" },
    group: "holdout",
  },
  {
    text: "Sounds good. Create the migration script now.",
    thread: AFTER_CHAT,
    expect: { role: "dev", scope: "new" },
    codeRequest: true,
    group: "holdout",
  },
];
