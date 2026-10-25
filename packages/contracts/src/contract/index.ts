import { approvalRules } from "./approval-rules";
import { approvals, questions } from "./cards";
import { chat } from "./chat";
import { avatars, bots, groups } from "./config-bots";
import { mcp, owner, skills } from "./config-skills";
import { control } from "./control";
import { conversations } from "./conversations";
import { events } from "./events";
import { memory } from "./memory";
import { ops } from "./ops";
import { tickets } from "./tickets";

/** The shared oRPC contract: every router of the web app API. */
export const contract = {
  conversations,
  chat,
  approvals,
  questions,
  control,
  tickets,
  ops,
  config: { bots, groups, avatars, skills, mcp, owner, approvalRules },
  memory,
  events,
};
