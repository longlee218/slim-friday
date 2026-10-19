import type { ReportInput } from "../lead/lead-schemas";

/** Where a worker run's report lands: the engine reads `report` after the run ends (first call wins). */
export interface ReportSink {
  report?: ReportInput;
  /** Artifact ids of the report, after the refs were checked (a repo doc is registered by then). */
  artifactIds?: string[];
  /** Set by `Report blocker`: why the run stopped and what it needs. The end event carries it and the lead is woken at once. */
  blocker?: { reason: string; needs: string };
  /** Set for a run that has no blocker action (the planner): `Report blocker` refuses. */
  noBlocker?: true;
}
