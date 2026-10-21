import { enDigest } from "./digest";
import { enLimits } from "./limits";
import { enMisc } from "./misc";
import { enPlan } from "./plan";
import { enRun } from "./run";
import { enStatus } from "./status";
import { enUi } from "./ui";

/** The English catalog: the source language, its keys are the `MessageKey` type. */
export const en = {
  ...enDigest,
  ...enLimits,
  ...enMisc,
  ...enPlan,
  ...enRun,
  ...enStatus,
  ...enUi,
};
