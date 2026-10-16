/** Description the model reads for the `ProposePlanRevision` tool. */
export const PROPOSE_PLAN_REVISION_DESCRIPTION =
  "A new plan version: add items, cancel keys, modify a not-started item. baseVersion must be the latest (STALE_VERSION otherwise). At most 3 revisions. Within the approved envelope it applies at once; when the envelope grows the owner must approve the new version.";
