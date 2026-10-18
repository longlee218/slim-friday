import type { OwnerLanguage, UserNotice } from "./user-copy";

/** Notices about the state of a run: start, queue, steer, stop, outcome, failure, note, decision. */
export type RunNotice = Extract<
  UserNotice,
  {
    kind:
      | "start"
      | "steer"
      | "queue"
      | "clarification"
      | "stop"
      | "replacement"
      | "outcome"
      | "failure"
      | "note"
      | "decision";
  }
>;

/** [vi, en] pairs by state. */
const STEER = {
  queued: [
    "Đã nhận, mình chuyển ý này cho việc đang làm.",
    "Got it, I passed this to the work in progress.",
  ],
  held: [
    "Đã nhận, mình giữ ý này và chuyển cho việc đang làm khi sẵn sàng. Chưa áp dụng.",
    "Got it, I’m holding this and will pass it to the work in progress when it is ready. Not applied yet.",
  ],
  waiting: [
    "Đã nhận, mình đang đợi bạn trả lời hoặc duyệt ở trên rồi mới chuyển ý này đi. Chưa áp dụng.",
    "Got it, I’m waiting for your answer or approval above before passing this on. Not applied yet.",
  ],
  full: [
    "Chưa nhận được vì hàng chờ đầy, nên chưa áp dụng. Bạn gửi lại sau nhé.",
    "I could not take this because the queue is full, so it is not applied. Please send it again later.",
  ],
  resumed: [
    "Đã nhận câu trả lời của bạn, việc đang chờ sẽ chạy tiếp.",
    "Got your answer: the waiting task continues.",
  ],
  ended: [
    "Việc đang làm vừa xong nên ý này chưa được chuyển hay áp dụng. Bạn gửi lại nhé.",
    "The work just finished, so this was not passed on or applied. Please send it again.",
  ],
} as const;

const OUTCOME = {
  aborted: ["Đã dừng.", "Stopped."],
  quota: [
    "Việc chưa hoàn tất vì dịch vụ đang giới hạn xử lý. Bạn hãy thử lại sau.",
    "The work did not finish because the service is limiting requests. Please try again later.",
  ],
  max_budget: [
    "Việc chưa hoàn tất vì đã chạm giới hạn chi phí đã cho phép.",
    "The work did not finish because the allowed spending limit was reached.",
  ],
  max_turns: [
    "Việc chưa hoàn tất vì đã chạm giới hạn xử lý của lần chạy này.",
    "The work did not finish because this run reached its processing limit.",
  ],
  timeout: [
    "Việc chưa hoàn tất vì hết thời gian xử lý. Bạn có thể gửi lại yêu cầu.",
    "The work did not finish because processing timed out. You can send the request again.",
  ],
} as const;
const OUTCOME_OTHER = [
  "Mình chưa hoàn tất yêu cầu này. Bạn có thể thử lại.",
  "I did not finish your request. You can try again.",
] as const;

const FAILURE = {
  busy: [
    "Mình đang xử lý việc khác. Bạn hãy thử lại sau một lát.",
    "I’m handling other work. Please try again shortly.",
  ],
  budget: [
    "Chưa bắt đầu vì đã chạm giới hạn chi phí cho phép. Bạn có thể gửi một yêu cầu mới.",
    "Nothing started because the allowed spending limit was reached. You can send a new request.",
  ],
  location: [
    "Không tìm thấy nơi làm việc bạn chọn. Bạn hãy kiểm tra tên hoặc chọn lại nơi làm việc.",
    "I could not find the location you selected. Please check its name or choose another location.",
  ],
  approval: [
    "Chưa bắt đầu vì cần bật chức năng phê duyệt trên Discord.",
    "Nothing started because Discord approvals need to be enabled.",
  ],
  expired: [
    "Yêu cầu này không còn chờ xử lý; chưa bắt đầu. Bạn hãy gửi lại yêu cầu.",
    "This request is no longer waiting; nothing started. Please send it again.",
  ],
  ceiling: [
    "Chưa bắt đầu vì việc này đã dùng hết giới hạn chi phí và không thể tăng thêm. Bạn hãy gửi một yêu cầu mới.",
    "Nothing started because this work has used up its spending limit, which cannot be raised. Please send a new request.",
  ],
  drain: [
    "Mình đang cập nhật. Bạn hãy thử lại sau một lát.",
    "I’m updating. Please try again shortly.",
  ],
} as const;

const NOTE = {
  "no-delivery": [
    "Lưu ý: lần chạy này chưa có commit, push hay PR nào.",
    "Note: nothing was committed, pushed or opened as a PR in this run.",
  ],
  "empty-text": ["Bạn hãy gửi kèm nội dung yêu cầu.", "Send a message with the task."],
  "stop-in-thread": [
    "Bạn gửi `/stop` trong thread của lần chạy nhé.",
    "Send `/stop` inside the thread of the run.",
  ],
  "status-in-thread": [
    "Bạn gửi `/status` trong thread của lần chạy nhé.",
    "Send `/status` inside the thread of the run.",
  ],
  "not-allowed": ["Bạn không có quyền dùng lệnh này.", "Not allowed."],
  "channel-unavailable": ["Hiện chưa dùng được kênh này. Bạn hãy thử lại.", "Channel unavailable."],
} as const;

const DECISION = {
  confirm: [
    "Bạn muốn mình thực hiện việc vừa trao đổi chứ?",
    "Would you like me to carry out what we just discussed?",
  ],
  gate: [
    "Bạn hãy chọn bằng các nút ở tin nhắn trên.",
    "Please use the buttons on the message above.",
  ],
  none: [
    "Hiện không có câu hỏi nào đang chờ bạn trả lời.",
    "There is no question waiting for your answer.",
  ],
  dropped: ["Đã bỏ yêu cầu này.", "Dropped this request."],
  "decline-busy": [
    "Mình vẫn đang xử lý việc hiện tại. Bạn hãy trả lời lại sau khi việc đó kết thúc.",
    "I’m still handling the current work. Please answer again after it ends.",
  ],
} as const;

/** Render a run notice from application facts only, with no claim that a model applied an unread message. */
export function renderRunNotice(event: RunNotice, language: OwnerLanguage): string {
  const say = (vi: string, en: string) => (language === "vi" ? vi : en);
  const pick = ([vi, en]: readonly [string, string]) => say(vi, en);
  switch (event.kind) {
    case "start":
      return say("Mình bắt đầu xử lý yêu cầu này.", "I’m starting on your request.");
    case "steer":
      return pick(STEER[event.state]);
    case "queue":
      return event.full
        ? say(
            "Hàng chờ đã đầy. Bạn hãy gửi lại khi việc hiện tại kết thúc.",
            "The queue is full. Please send this again when the current work ends.",
          )
        : say(
            "Đã nhận yêu cầu; mình sẽ xử lý sau việc đang làm.",
            "Received your request; I’ll handle it after the current work.",
          );
    case "clarification":
      return event.pending
        ? say(
            "Mình chưa rõ câu trả lời của bạn cho câu hỏi ở trên. Bạn nói rõ lựa chọn muốn thực hiện nhé.",
            "I’m not sure how that answers the question above. Please clarify what you want to do.",
          )
        : say(
            "Bạn nói rõ hơn điều muốn mình làm nhé.",
            "Could you clarify what you want me to do?",
          );
    case "replacement":
      return say(
        "Mình đang dừng việc hiện tại trước khi xử lý yêu cầu mới.",
        "I’m stopping the current work before handling your new request.",
      );
    case "stop":
      return event.active
        ? say("Mình đang dừng việc hiện tại.", "I’m stopping the current work.")
        : say("Hiện không có việc nào đang chạy.", "Nothing is running.");
    case "outcome": {
      const text = pick(OUTCOME[event.outcome as keyof typeof OUTCOME] ?? OUTCOME_OTHER);
      if (event.outcome !== "quota" || !event.resetsAt) return text;
      const at = new Date(event.resetsAt).toISOString();
      return text + say(` Có thể thử lại sau ${at}.`, ` You can try again after ${at}.`);
    }
    case "failure": {
      // No known cause: the generic "did not finish" outcome.
      if (!event.cause) return renderRunNotice({ kind: "outcome", outcome: "error" }, language);
      const names = event.cause === "location" && event.names?.length ? event.names.join(", ") : "";
      const known = names ? say(` Các nơi hợp lệ: ${names}.`, ` Valid locations: ${names}.`) : "";
      return pick(FAILURE[event.cause]) + known;
    }
    case "note":
      return pick(NOTE[event.state]);
    case "decision":
      return pick(DECISION[event.state]);
  }
}
