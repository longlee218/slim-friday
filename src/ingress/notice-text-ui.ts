import type { OwnerLanguage, UserNotice } from "./user-copy";

/** Notices for buttons, labels, choices and channel adoption. */
export type UiNotice = Extract<
  UserNotice,
  {
    kind:
      | "ask-after-location"
      | "channel-adopted"
      | "channel-adopt-refused"
      | "approval"
      | "choice"
      | "label";
  }
>;

const UI_KINDS: ReadonlySet<string> = new Set<UiNotice["kind"]>([
  "ask-after-location",
  "channel-adopted",
  "channel-adopt-refused",
  "approval",
  "choice",
  "label",
]);

/** Type guard: true for the notices this module renders. */
export const isUiNotice = (event: UserNotice): event is UiNotice => UI_KINDS.has(event.kind);

/** [vi, en] pairs by state. */
const ADOPT_REFUSED = {
  "not-private": [
    "Chưa liên kết kênh này vì kênh không riêng tư. Hãy đặt kênh đồng bộ quyền với category (chỉ bạn và bot xem được) rồi @mention lại.",
    "I did not link this channel because it is not private. Sync its permissions with the category (only you and the bot can see it), then mention me again.",
  ],
  ambiguous: [
    "Chưa liên kết kênh này vì category khớp nhiều space. Hãy kiểm tra cấu hình space.",
    "I did not link this channel because its category matches more than one space. Check the space setup.",
  ],
  "name-taken": [
    "Chưa liên kết kênh này vì đã có quá nhiều kênh trùng tên. Hãy đổi tên kênh rồi @mention lại.",
    "I did not link this channel because too many channels already use this name. Rename it and mention me again.",
  ],
  failed: [
    "Chưa liên kết được kênh này (xem log). Hãy thử lại hoặc dùng /init-channel.",
    "I could not link this channel (see the logs). Try again or use /init-channel.",
  ],
} as const;

const APPROVAL = {
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

const LABEL = {
  "yes-run": ["Có, chạy đi", "Yes, run it"],
  no: ["Không", "No"],
  "reply-attached": ["[đã đính kèm toàn bộ câu trả lời]", "[full reply attached]"],
  "full-result": ["Kết quả đầy đủ", "Full result"],
} as const;

/** Render a UI notice in the owner's language. */
export function renderUiNotice(event: UiNotice, language: OwnerLanguage): string {
  const say = (vi: string, en: string) => (language === "vi" ? vi : en);
  const pick = ([vi, en]: readonly [string, string]) => say(vi, en);
  switch (event.kind) {
    case "ask-after-location":
      return say(
        `Bạn gửi câu hỏi sau "location:${event.name}" nhé.`,
        `Send your question after "location:${event.name}".`,
      );
    case "channel-adopted":
      return say(
        `Đã liên kết #${event.name} với space ${event.space} (mode task). Gửi một đường dẫn để thêm nơi làm việc.`,
        `Linked #${event.name} to space ${event.space} (mode task). Say a path to add a working location.`,
      );
    case "channel-adopt-refused":
      return pick(ADOPT_REFUSED[event.reason]);
    case "approval":
      return pick(APPROVAL[event.state]);
    case "label":
      return pick(LABEL[event.state]);
    case "choice":
      return event.state === "chose"
        ? say(`Đã chọn: ${event.text}`, `Chose: ${event.text}`)
        : say(`Đã trả lời: ${event.text}`, `Answered: ${event.text}`);
  }
}
