import type { enRun } from "../en/run";

export const viRun: Record<keyof typeof enRun, string> = {
  "run.start": "Mình làm ngay nhé.",
  "run.steer.queued": "Ok, mình chuyển ý này cho việc đang làm rồi.",
  "run.steer.held":
    "Ok, mình giữ ý này và sẽ chuyển ngay khi việc đang làm sẵn sàng nhận, nên chưa áp dụng đâu.",
  "run.steer.waiting":
    "Ok, mình đợi bạn trả lời câu hỏi phía trên rồi mới chuyển ý này đi. Chưa áp dụng nhé.",
  "run.steer.full":
    "Hàng chờ đang đầy nên mình chưa nhận được ý này. Lát nữa bạn gửi lại giúp mình nhé.",
  "run.steer.resumed": "Mình nhận được câu trả lời rồi, việc đang chờ sẽ chạy tiếp.",
  "run.steer.ended": "Việc đó vừa xong nên ý này chưa tới nơi. Bạn gửi lại giúp mình nhé.",
  "run.queue.full": "Hàng chờ đang đầy. Bạn gửi lại khi việc hiện tại xong nhé.",
  "run.queue.received": "Mình nhận yêu cầu rồi, sẽ làm ngay sau việc đang chạy.",
  "run.clarification.pending":
    "Mình chưa hiểu câu này trả lời cho câu hỏi phía trên thế nào. Bạn muốn chọn gì nhỉ?",
  "run.clarification.ask": "Bạn nói rõ hơn một chút điều bạn muốn mình làm nhé?",
  "run.replacement": "Mình dừng việc đang làm để chuyển sang yêu cầu mới của bạn.",
  "run.stop.active": "Mình đang dừng việc hiện tại.",
  "run.stop.idle": "Hiện không có việc nào đang chạy.",
  "run.outcome.aborted": "Đã dừng.",
  "run.outcome.quota":
    "Chưa xong được vì dịch vụ đang giới hạn lượt xử lý. Bạn thử lại sau một lúc nhé.",
  "run.outcome.max_budget": "Chưa xong vì đã chạm giới hạn chi phí.",
  "run.outcome.max_turns": "Chưa xong vì lần chạy này đã chạm giới hạn xử lý.",
  "run.outcome.timeout": "Chưa xong vì chạy quá lâu. Bạn có thể gửi lại yêu cầu.",
  "run.outcome.other": "Mình chưa làm xong việc này. Bạn thử lại nhé?",
  "run.outcome.retryAfter": " Bạn có thể thử lại sau {at}.",
  "run.failure.busy": "Mình đang bận việc khác. Bạn thử lại sau ít phút nhé.",
  "run.failure.budget":
    "Mình chưa bắt đầu vì đã chạm giới hạn chi phí. Bạn có thể gửi yêu cầu mới.",
  "run.failure.location":
    "Mình không tìm thấy nơi làm việc bạn chọn. Bạn kiểm tra lại tên hoặc chọn nơi khác nhé.",
  "run.failure.approval":
    "Mình chưa bắt đầu được vì cần bật tính năng phê duyệt trên Discord trước.",
  "run.failure.expired": "Yêu cầu này không còn chờ nữa nên chưa chạy gì cả. Bạn gửi lại nhé.",
  "run.failure.ceiling":
    "Mình chưa bắt đầu vì việc này đã dùng hết giới hạn chi phí và không tăng thêm được. Bạn gửi yêu cầu mới nhé.",
  "run.failure.drain": "Mình đang cập nhật. Bạn thử lại sau ít phút nhé.",
  "run.failure.validLocations": " Các nơi mình biết: {names}.",
  "run.note.no-delivery": "Lưu ý: lần này chưa có commit, push hay PR nào.",
  "run.note.empty-text": "Bạn gửi kèm nội dung cần làm nhé.",
  "run.note.stop-in-thread": "Bạn gửi `/stop` trong thread của lần chạy nhé.",
  "run.note.status-in-thread": "Bạn gửi `/status` trong thread của lần chạy nhé.",
  "run.note.not-allowed": "Bạn không có quyền dùng lệnh này.",
  "run.note.channel-unavailable": "Hiện mình chưa dùng được kênh này. Bạn thử lại nhé.",
  "run.decision.confirm": "Bạn muốn mình làm luôn việc vừa bàn chứ?",
  "run.decision.gate": "Bạn chọn bằng các nút ở tin nhắn phía trên nhé.",
  "run.decision.none": "Hiện không có câu hỏi nào đang chờ bạn trả lời.",
  "run.decision.dropped": "Ok, mình bỏ yêu cầu này.",
  "run.decision.decline-busy":
    "Mình vẫn đang làm việc hiện tại. Bạn trả lời lại sau khi nó xong nhé.",
};
