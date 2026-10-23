import type { ReportInput } from "../lead/lead-schemas";
import type { ReportFile } from "./report-files";
import type { ReportImage } from "./report-images";

/** Where a worker run's report lands: the engine reads `report` after the run ends (first call wins). */
export interface ReportSink {
  report?: ReportInput;
  /** Deliverable files of the report, checked (a scratch file is copied by then); stored on the result message. */
  files?: ReportFile[];
  /** Screenshots of the report, checked (inside scratch, image bytes, size); the engine posts them once when the run ends. */
  images?: ReportImage[];
  /** Set by `Report blocker`: why the run stopped and what it needs. The end event carries it and the lead is woken at once. */
  blocker?: { reason: string; needs: string; messageId?: string };
}
