import type { ReportInput } from "../lead/lead-schemas";

/** Where a worker run's report lands: the engine reads `report` after the run ends (first call wins). */
export interface ReportSink {
  report?: ReportInput;
}
