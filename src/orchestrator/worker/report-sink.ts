import type { ReportInput } from "../lead/lead-schemas";

/** Where a worker run's report lands: the engine reads `report` after the run ends (first call wins). */
export interface ReportSink {
  report?: ReportInput;
  /** Artifact ids of the report, after the refs were checked (a repo doc is registered by then). */
  artifactIds?: string[];
}
