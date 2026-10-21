import type { enDigest } from "../en/digest";

export const viDigest: Record<keyof typeof enDigest, string> = {
  "digest.checkIn": "Cập nhật: {objective}",
  "digest.done": "Xong {done}/{total} việc.",
  "digest.held": " - đang chờ bạn quyết định",
  "digest.plan": "Kế hoạch: v{version}",
  "digest.spend": "Đã dùng: {spent} / {budget}",
};
