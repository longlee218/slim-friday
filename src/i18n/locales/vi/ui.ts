import type { enUi } from "../en/ui";

export const viUi: Record<keyof typeof enUi, string> = {
  "ui.askAfterLocation": 'Bạn ghi câu hỏi sau "location:{name}" nhé.',
  "ui.channelAdopted":
    "Đã liên kết #{name} với space {space} (chế độ task). Gửi mình một đường dẫn nếu bạn muốn thêm nơi làm việc.",
  "ui.adoptRefused.not-private":
    "Mình chưa liên kết kênh này vì nó không riêng tư. Bạn đồng bộ quyền của kênh với category (chỉ bạn và bot xem được) rồi @mention mình lại nhé.",
  "ui.adoptRefused.ambiguous":
    "Mình chưa liên kết kênh này vì category của nó khớp với nhiều space. Bạn kiểm tra lại cấu hình space nhé.",
  "ui.adoptRefused.name-taken":
    "Mình chưa liên kết kênh này vì đã có quá nhiều kênh trùng tên. Bạn đổi tên kênh rồi @mention mình lại nhé.",
  "ui.adoptRefused.failed":
    "Mình chưa liên kết được kênh này (xem log để biết thêm). Bạn thử lại hoặc dùng /teammate create nhé.",
  "ui.approval.approve": "Duyệt",
  "ui.approval.deny": "Từ chối",
  "ui.approval.owner-only": "Chỉ chủ sở hữu mới duyệt được.",
  "ui.approval.expired": "Yêu cầu này đã hết hạn.",
  "ui.approval.timeout": "Đã hết thời gian chờ.",
  "ui.approval.cancelled": "Đã hủy.",
  "ui.approval.enter": "Nhập câu trả lời",
  "ui.approval.modal-title": "Câu trả lời của bạn",
  "ui.approval.placeholder": "Chọn một đáp án",
  "ui.approval.full-text": "(nội dung đầy đủ nằm trong tệp đính kèm)",
  "ui.approval.options-in-file":
    "Các đáp án nằm trong tệp đính kèm. Bấm nút để nhập câu trả lời của bạn.",
  "ui.label.yes-run": "Có, làm đi",
  "ui.label.no": "Không",
  "ui.label.reply-attached": "[đã đính kèm toàn bộ câu trả lời]",
  "ui.label.full-result": "Kết quả đầy đủ",
  "ui.choice.chose": "Bạn đã chọn: {text}",
  "ui.choice.answered": "Bạn đã trả lời: {text}",
};
