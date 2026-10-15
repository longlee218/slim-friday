import { francAll } from "franc-min";
import type { RecentMessage } from "../intent/intent-types";

/** The two conversation languages supported by application notices. */
export type OwnerLanguage = "vi" | "en";

/** Verified application facts; exceptions, IDs and raw request briefs are deliberately absent. */
export type UserNotice =
  | { kind: "start" }
  | { kind: "steer"; state: "queued" | "held" | "waiting" | "full" | "ended" }
  | { kind: "queue"; full?: boolean }
  | { kind: "clarification"; pending?: boolean }
  | { kind: "stop"; active: boolean }
  | { kind: "replacement" }
  | { kind: "outcome"; outcome: string; resumable?: boolean; resetsAt?: number }
  | {
      kind: "failure";
      cause?:
        | "busy"
        | "budget"
        | "location"
        | "resume"
        | "approval"
        | "expired"
        | "drain"
        | "ceiling"
        | "owner";
      /** Valid location names, listed back to the owner for `cause: "location"` (names are not secrets). */
      names?: string[];
    }
  | {
      kind: "note";
      state:
        | "no-delivery"
        | "resume-task-lost"
        | "resume-cleared"
        | "cannot-resume"
        | "stale-resume"
        | "budget-stop"
        | "empty-text"
        | "stop-in-thread"
        | "status-in-thread"
        | "not-allowed"
        | "channel-unavailable";
    }
  | { kind: "ask-after-location"; name?: string }
  | {
      kind: "approval";
      state:
        | "approve"
        | "deny"
        | "owner-only"
        | "expired"
        | "timeout"
        | "cancelled"
        | "enter"
        | "modal-title"
        | "placeholder"
        | "full-text"
        | "options-in-file";
    }
  | { kind: "choice"; state: "chose" | "answered"; text: string }
  /** Short labels and gate questions; never matched back by text (a bare "No" must not be replaced). */
  | {
      kind: "label";
      state: "yes-run" | "no" | "reply-attached" | "max-effort" | "escalate-opus" | "max-declined";
    }
  | {
      kind: "decision";
      state:
        | "confirm"
        | "gate"
        | "none"
        | "dropped"
        | "kept"
        | "resume"
        | "restart"
        | "resuming"
        | "decline-busy"
        | "undelivered";
    };

/** Digits, yes/no and slash commands say nothing about the language: they inherit the conversation's. */
const NEUTRAL = /^(?:\d+|yes|no|ok|okay|go|stop|\/go(?: \+\d+(?:\.\d+)?)?|\/stop)[.!?]*$/i;
/** Vietnamese diacritics; any of them settles the language. */
const VI_MARKS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
/** The detector must beat the other language by this much, else the text is treated as undecided. */
const DETECT_MARGIN = 0.3;

/** Detect vi/en from one text with franc (diacritics first); undefined when neutral, too short or ambiguous. */
export function detectLanguage(value: string): OwnerLanguage | undefined {
  const t = value.trim();
  if (NEUTRAL.test(t)) return;
  if (VI_MARKS.test(t)) return "vi";
  const [top, second] = francAll(t, { only: ["vie", "eng"], minLength: 3 });
  if (!top || top[0] === "und" || (second && top[1] - second[1] < DETECT_MARGIN)) return;
  return top[0] === "vie" ? "vi" : "en";
}

/**
 * Conversation language of the owner's text. Neutral or ambiguous text inherits the latest recognizable OWNER
 * message of `recent` (bot messages never count); with none, Vietnamese.
 */
export function languageOf(text: string, recent: RecentMessage[] = []): OwnerLanguage {
  return (
    detectLanguage(text) ??
    [...recent]
      .reverse()
      .filter((m) => m.from === "owner")
      .map((m) => detectLanguage(m.text))
      .find(Boolean) ??
    "vi"
  );
}

/** Ingress can pin the language once; non-Discord callers use the same fallback. */
export function messageLanguage(message: {
  text: string;
  recent?: RecentMessage[];
  language?: OwnerLanguage;
}): OwnerLanguage {
  return message.language ?? languageOf(message.text, message.recent);
}

/** Threads whose language ingress pinned; bounded (oldest dropped) so a long-lived bot does not grow it forever. */
const PINNED_MAX = 500;
const pinned = new Map<string, OwnerLanguage>();

/** Record the language ingress decided for a thread: the one source buttons, selects and notices read. */
export function pinThreadLanguage(threadId: string, language: OwnerLanguage): void {
  pinned.delete(threadId); // re-insert so the most recently used threads survive the cap
  pinned.set(threadId, language);
  if (pinned.size > PINNED_MAX) {
    const oldest = pinned.keys().next();
    if (!oldest.done) pinned.delete(oldest.value);
  }
}

/** The language pinned for a thread, undefined before ingress saw any message there (e.g. after a restart). */
export const pinnedThreadLanguage = (threadId: string): OwnerLanguage | undefined =>
  pinned.get(threadId);

/** Render only what the application knows happened, with no claim that a model applied an unread message. */
function render(event: UserNotice, language: OwnerLanguage): string {
  const say = (vi: string, en: string) => (language === "vi" ? vi : en);
  switch (event.kind) {
    case "start":
      return say("Mình bắt đầu xử lý yêu cầu này.", "I’m starting on your request.");
    case "steer": {
      const copy = {
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
        ended: [
          "Việc đang làm vừa xong nên ý này chưa được chuyển hay áp dụng. Bạn gửi lại nhé.",
          "The work just finished, so this was not passed on or applied. Please send it again.",
        ],
      } as const;
      return say(copy[event.state][0], copy[event.state][1]);
    }
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
      return !event.active
        ? say("Hiện không có việc nào đang chạy.", "Nothing is running.")
        : say("Mình đang dừng việc hiện tại.", "I’m stopping the current work.");
    case "outcome": {
      const text =
        event.outcome === "aborted"
          ? say("Đã dừng.", "Stopped.")
          : event.outcome === "quota"
            ? say(
                "Việc chưa hoàn tất vì dịch vụ đang giới hạn xử lý. Bạn hãy thử lại sau.",
                "The work did not finish because the service is limiting requests. Please try again later.",
              )
            : event.outcome === "max_budget"
              ? say(
                  "Việc chưa hoàn tất vì đã chạm giới hạn chi phí đã cho phép.",
                  "The work did not finish because the allowed spending limit was reached.",
                )
              : event.outcome === "max_turns"
                ? say(
                    "Việc chưa hoàn tất vì đã chạm giới hạn xử lý của lần chạy này.",
                    "The work did not finish because this run reached its processing limit.",
                  )
                : event.outcome === "timeout"
                  ? say(
                      "Việc chưa hoàn tất vì hết thời gian xử lý. Bạn có thể gửi lại yêu cầu.",
                      "The work did not finish because processing timed out. You can send the request again.",
                    )
                  : say(
                      "Mình chưa hoàn tất yêu cầu này. Bạn có thể thử lại.",
                      "I did not finish your request. You can try again.",
                    );
      const reset =
        event.outcome === "quota" && event.resetsAt
          ? say(
              ` Có thể thử lại sau ${new Date(event.resetsAt).toISOString()}.`,
              ` You can try again after ${new Date(event.resetsAt).toISOString()}.`,
            )
          : "";
      return (
        text +
        reset +
        (event.resumable
          ? `\n${renderUserNotice({ kind: "decision", state: "resume" }, language)}`
          : "")
      );
    }
    case "failure": {
      const copy = {
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
        resume: [
          "Không còn dữ liệu để tiếp tục việc này. Bạn hãy gửi lại yêu cầu để bắt đầu lại.",
          "The saved work is no longer available to continue. Please send the request again to restart.",
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
        owner: ["Chỉ chủ sở hữu mới có thể tiếp tục việc này.", "Only the owner can resume."],
        drain: [
          "Mình đang cập nhật. Bạn hãy thử lại sau một lát.",
          "I’m updating. Please try again shortly.",
        ],
      } as const;
      const names = event.cause === "location" && event.names?.length ? event.names.join(", ") : "";
      const known = names ? say(` Các nơi hợp lệ: ${names}.`, ` Valid locations: ${names}.`) : "";
      return event.cause
        ? say(copy[event.cause][0], copy[event.cause][1]) + known
        : renderUserNotice({ kind: "outcome", outcome: "error" }, language);
    }
    case "ask-after-location":
      return say(
        `Bạn gửi câu hỏi sau "location:${event.name}" nhé.`,
        `Send your question after "location:${event.name}".`,
      );
    case "note": {
      const copy = {
        "no-delivery": [
          "Lưu ý: lần chạy này chưa có commit, push hay PR nào.",
          "Note: nothing was committed, pushed or opened as a PR in this run.",
        ],
        "resume-task-lost": [
          "Không tiếp tục được phiên làm việc trước. Bạn hãy gửi lại yêu cầu để bắt đầu lại.",
          "Could not resume the task's session; start the task again.",
        ],
        "resume-cleared": [
          "Không tiếp tục được phiên trước nên đã xóa nó. Bạn hãy gửi lại tin nhắn.",
          "Could not resume the previous session; it was cleared. Please send your message again.",
        ],
        "cannot-resume": [
          "Không thể tiếp tục: chưa có phiên nào được lưu cho cuộc trò chuyện này. Bạn hãy gửi lại yêu cầu.",
          "Cannot resume: no saved session for this thread. Start the task again.",
        ],
        "stale-resume": [
          "Lệnh tiếp tục này đã cũ: cuộc trò chuyện đã đi tiếp.",
          "This Resume is out of date: the thread has moved on.",
        ],
        "budget-stop": [
          "Việc này đã dừng vì chạm giới hạn chi phí. Bạn gửi `/go +<usd>` để tiếp tục với thêm chi phí.",
          "That task stopped on its budget. Reply `/go +<usd>` to continue with more budget.",
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
        "channel-unavailable": [
          "Hiện chưa dùng được kênh này. Bạn hãy thử lại.",
          "Channel unavailable.",
        ],
      } as const;
      return say(copy[event.state][0], copy[event.state][1]);
    }
    case "approval": {
      const copy = {
        approve: ["Duyệt", "Approve"],
        deny: ["Từ chối", "Deny"],
        "owner-only": ["Chỉ chủ sở hữu mới có thể phê duyệt.", "Only the owner can approve."],
        expired: ["Yêu cầu này đã hết hạn.", "This action expired."],
        timeout: ["Đã hết thời gian chờ.", "Timed out."],
        cancelled: ["Đã hủy.", "Cancelled."],
        enter: ["Nhập câu trả lời", "Enter answer"],
        "modal-title": ["Câu trả lời của bạn", "Your answer"],
        placeholder: ["Chọn một đáp án", "Choose an option"],
        "full-text": ["(nội dung đầy đủ trong tệp đính kèm)", "(full text in the attached file)"],
        "options-in-file": [
          "Danh sách đáp án nằm trong tệp đính kèm; bấm nút để nhập câu trả lời.",
          "The options are in the attached file; use the button to type your answer.",
        ],
      } as const;
      return say(copy[event.state][0], copy[event.state][1]);
    }
    case "label": {
      const copy = {
        "yes-run": ["Có, chạy đi", "Yes, run it"],
        no: ["Không", "No"],
        "reply-attached": ["[đã đính kèm toàn bộ câu trả lời]", "[full reply attached]"],
        "max-effort": [
          "Việc này cần mức nỗ lực tối đa (Opus, chi phí gấp khoảng 5 lần). Chạy theo cách đó chứ?",
          "That asks for max effort (Opus, about 5x the cost). Run it that way?",
        ],
        "max-declined": [
          "Chưa xác nhận mức nỗ lực tối đa: đã chạy ở mức cao.",
          "Max effort not confirmed: ran at high.",
        ],
        "escalate-opus": [
          "Mô hình rẻ hơn chưa trả lời tốt việc này. Chạy lại bằng Opus (chi phí gấp khoảng 5 lần) chứ?",
          "The cheaper model could not answer this well. Re-run it on Opus (about 5x the cost)?",
        ],
      } as const;
      return say(copy[event.state][0], copy[event.state][1]);
    }
    case "choice":
      return event.state === "chose"
        ? say(`Đã chọn: ${event.text}`, `Chose: ${event.text}`)
        : say(`Đã trả lời: ${event.text}`, `Answered: ${event.text}`);
    case "decision": {
      const copy = {
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
        kept: [
          "Đã giữ lại. Bạn có thể gửi `/go` khi muốn tiếp tục.",
          "Kept it. Send `/go` when you want to continue.",
        ],
        resume: [
          "Bạn muốn tiếp tục từ chỗ đã dừng chứ? Trả lời đồng ý hoặc gửi `/go`.",
          "Would you like to continue from where it stopped? Reply yes or send `/go`.",
        ],
        restart: [
          "Friday đã khởi động lại khi việc còn dang dở. Bấm Tiếp tục để làm tiếp.",
          "Friday restarted while the work was unfinished. Press Continue to carry on.",
        ],
        resuming: ["Mình đang tiếp tục xử lý.", "I’m continuing the work."],
        "decline-busy": [
          "Mình vẫn đang xử lý việc hiện tại. Bạn hãy trả lời lại sau khi việc đó kết thúc.",
          "I’m still handling the current work. Please answer again after it ends.",
        ],
        undelivered: [
          "Các bổ sung sau chưa được chuyển hay áp dụng vì việc đã kết thúc. Bạn hãy gửi lại:",
          "These updates were not delivered or applied before the work ended. Please send them again:",
        ],
      } as const;
      return say(copy[event.state][0], copy[event.state][1]);
    }
  }
}

/**
 * Every English notice rendered by the app registers itself here (text -> event), so the boundary can render it
 * again in the owner's language without a hand-kept table: a new notice cannot be forgotten.
 */
const ENGLISH_NOTICES = new Map<string, UserNotice>();

/** Render a notice in the owner's language (English renders are remembered for `localizeUserCopy`). */
export function renderUserNotice(event: UserNotice, language: OwnerLanguage): string {
  const text = render(event, language);
  // Outcomes with times and approval/choice texts (labels, owner words) are never matched back by text.
  const dynamic =
    event.kind === "approval" ||
    event.kind === "choice" ||
    event.kind === "label" ||
    (event.kind === "outcome" && (event.resetsAt || event.resumable));
  if (language === "en" && !dynamic) ENGLISH_NOTICES.set(text, event);
  return text;
}

/**
 * Localize app-generated notices that deeper code rendered in English. Only a LINE that equals a registered notice
 * is replaced, so a model's sentence that merely contains the same words (or an answer in the middle of a line)
 * is never rewritten.
 */
export function localizeUserCopy(text: string, language: OwnerLanguage): string {
  if (language === "en") return text;
  return text
    .split("\n")
    .map((line) => {
      const event = ENGLISH_NOTICES.get(line);
      return event ? render(event, language) : line;
    })
    .join("\n");
}
