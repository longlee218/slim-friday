import type { enStatus } from "../en/status";

export const viStatus: Record<keyof typeof enStatus, string> = {
  "status.progress": "Tiến độ: {percent}%",
  "status.reported": "Báo cáo: {note}",
  "status.lastActivity": "Hoạt động gần nhất {ago} trước.",
  "status.nothing": "Không có việc nào đang chạy.",
  "status.tools": "Đã dùng {count} công cụ, gần nhất:",
  "status.noTools": "Chưa dùng công cụ nào.",
  "status.waitingTask": "Việc đang chờ ({who}), đã dừng cách đây {ago}.",
  "status.scope": "Phạm vi: {scope}",
  "status.running": "Đang chạy ({role}, {state}) được {ago}.",
  "status.approval": "Đang chờ bạn duyệt {tool} ({ago}).",
  "status.note": "Ghi chú mới nhất: {note}",
};
