import { approvalRules } from "./approval-rules";
import { approvals, questions } from "./cards";
import { chat } from "./chat";
import { computer } from "./computer";
import { avatars, bots, groups } from "./config-bots";
import { mcp, owner, skills } from "./config-skills";
import { control } from "./control";
import { conversations } from "./conversations";
import { events } from "./events";
import { memory } from "./memory";
import { ops } from "./ops";
import { models, permissions } from "./permissions";
import { schedules } from "./schedules";
import { tickets } from "./tickets";

/** The shared oRPC contract: every router of the web app API. */
export const contract = {
  conversations,
  chat,
  approvals,
  questions,
  control,
  computer,
  tickets,
  schedules,
  ops,
  config: { bots, groups, avatars, skills, mcp, owner, approvalRules, permissions, models },
  memory,
  events,
};
