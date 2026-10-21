import type { en } from "../en";
import { viDigest } from "./digest";
import { viLimits } from "./limits";
import { viMisc } from "./misc";
import { viPlan } from "./plan";
import { viRun } from "./run";
import { viStatus } from "./status";
import { viUi } from "./ui";

/** The Vietnamese catalog: every key of the English one (a missing key fails to compile). */
export const vi: Record<keyof typeof en, string> = {
  ...viDigest,
  ...viLimits,
  ...viMisc,
  ...viPlan,
  ...viRun,
  ...viStatus,
  ...viUi,
};
