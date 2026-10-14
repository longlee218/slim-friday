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
  | { kind: "stop"; active: boolean; queued?: number }
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

/** Render only what the application knows happened, with no claim that a model applied an unread message. */
function render(event: UserNotice, language: OwnerLanguage): string {
  const say = (vi: string, en: string) => (language === "vi" ? vi : en);
  switch (event.kind) {
    case "start":
      return say("Mình bắt đầu xử lý yêu cầu này.", "I’m starting on your request.");
    case "steer": {
      const copy = {
        queued: [
          "Đã nhận bổ sung và đưa vào đầu vào đang chờ; chưa xác nhận việc áp dụng.",
          "Received your update and queued it as input; it has not been confirmed as applied.",
        ],
        held: [
          "Đã nhận bổ sung và đang giữ để chuyển khi sẵn sàng; chưa áp dụng.",
          "Received your update and am holding it until ready; it has not been applied.",
        ],
        waiting: [
          "Đã lưu bổ sung; mình đang đợi bạn trả lời hoặc phê duyệt ở trên trước khi chuyển tiếp. Chưa áp dụng bổ sung này.",
          "Saved your update; I’m waiting for your answer or approval above before forwarding it. It has not been applied.",
        ],
        full: [
          "Chưa nhận được bổ sung vì hàng chờ đầy, nên chưa áp dụng. Bạn hãy gửi lại sau.",
          "The update could not be accepted because the queue is full, so it has not been applied. Please send it again later.",
        ],
        ended: [
          "Việc đang làm vừa kết thúc nên bổ sung chưa được chuyển hay áp dụng. Bạn hãy gửi lại.",
          "The work just ended, so your update was not delivered or applied. Please send it again.",
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
        : say(
            `Mình đang dừng việc hiện tại.${event.queued ? " Các yêu cầu đang chờ sẽ được xử lý sau đó." : ""}`,
            `I’m stopping the current work.${event.queued ? " The waiting requests will run afterwards." : ""}`,
          );
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
      return event.cause
        ? say(copy[event.cause][0], copy[event.cause][1])
        : renderUserNotice({ kind: "outcome", outcome: "error" }, language);
    }
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
  const dynamic = event.kind === "outcome" && (event.resetsAt || event.resumable);
  if (language === "en" && !dynamic) ENGLISH_NOTICES.set(text, event);
  return text;
}

/** Localize default notices that leaves rendered in English; arbitrary model/diagnostic text is untouched. */
export function localizeUserCopy(text: string, language: OwnerLanguage): string {
  if (language === "en") return text;
  // Longest first, so a notice that contains a shorter one is replaced whole.
  const known = [...ENGLISH_NOTICES].sort((a, b) => b[0].length - a[0].length);
  for (const [english, event] of known) text = text.replaceAll(english, render(event, language));
  return text;
}
