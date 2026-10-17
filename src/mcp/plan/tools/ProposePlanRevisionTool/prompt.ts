import { PLAN_MAX_REVISIONS } from "../../../../config/lead-caps";

/** Description the model reads for the `ProposePlanRevision` tool. */
export const PROPOSE_PLAN_REVISION_DESCRIPTION = `A new plan version: add items, cancel keys, modify a not-started item. baseVersion must be the latest (STALE_VERSION otherwise). At most ${PLAN_MAX_REVISIONS} revisions. Within the approved envelope and budget it applies at once; when the envelope grows or the budget changes the owner must approve the new version. A rolling wave activates deferred items with modify deferredScope=false.`;
