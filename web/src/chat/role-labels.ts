import type { RoleKey } from "./chat-types";

/** Display label per role template. */
export const ROLE_LABEL: Record<RoleKey, string> = {
  lead: "Chief of staff",
  developer: "Developer",
  tester: "Tester",
  researcher: "Researcher",
  designer: "Designer",
  writer: "Writer",
  devops: "DevOps",
  security: "Security",
};
