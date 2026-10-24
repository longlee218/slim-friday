import type { RunStepDto } from "@friday/contracts";

/** A run step with defaults; override with `extra`. */
export const step = (
  kind: RunStepDto["kind"],
  state: RunStepDto["state"] = "done",
  extra: Partial<RunStepDto> = {},
): RunStepDto => ({ id: `${kind}-${state}`, kind, state, label: "Did", startedAt: 0, ...extra });
