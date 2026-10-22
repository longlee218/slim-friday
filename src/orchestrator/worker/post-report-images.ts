import { readFileSync } from "node:fs";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { type LeadThreadCtx, postTo } from "../lead/lead-runtime";
import type { ReportImage } from "./report-images";

/** Logger of this module. */
const log = logger.child({ module: "report-images" });

/**
 * Post the images of an accepted report to the thread, once each: an https URL goes out as a link (Discord shows it
 * inline), a file as an attachment. Nothing is stored: the bytes are read from the run's scratch dir and sent. A failed post is logged and skipped (never retried, never fails the task).
 */
export async function postReportImages(ctx: LeadThreadCtx, images: ReportImage[]): Promise<void> {
  for (const image of images) {
    try {
      if ("url" in image) await postTo(ctx, image.url);
      else await postTo(ctx, "", { image: { name: image.name, bytes: readFileSync(image.path) } });
    } catch (err) {
      logEvent(log, "images.post_failed", { name: image.name, err: errText(err) }, "warn");
    }
  }
}
