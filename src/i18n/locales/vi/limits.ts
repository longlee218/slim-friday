import type { enLimits } from "../en/limits";

export const viLimits: Record<keyof typeof enLimits, string> = {
  "limits.roleTitle": "Giới hạn của {role}:",
  "limits.unknownRole": "Mình không biết vai trò nào tên {role}.",
  "limits.pools": "**Pool**",
  "limits.roles": "**Vai trò**",
  "limits.budgets": "**Ngân sách**",
  "limits.noDailyCap": "- Không có giới hạn theo ngày.",
  "limits.stops": "**Điều kiện dừng**",
  "limits.noRunTimeout": "- Không có timeout cho lần chạy, chỉ dừng bằng /stop.",
  "limits.subagents": "**Subagent được phép dùng**",
  "limits.other": "**Khác**",
  "limits.live": "**Hiện tại**",
  "limits.teammatePool": "- Teammate pool: đang dùng {used}/{cap}, {waiting} thread đang chờ",
  "limits.workerSlots": "- Worker slot: đang dùng {used}/{cap}",
  "limits.readyWaiting": "- Việc đã sẵn sàng nhưng đang chờ slot: {count}",
  "limits.threadRunning": "- <#{threadId}>: {count} việc đang chạy",
  "limits.noneRunning": "- Không có việc nào đang chạy.",
  "limits.moreThreads": "- và {count} thread nữa",
};
