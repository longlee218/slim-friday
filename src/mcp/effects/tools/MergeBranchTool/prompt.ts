/** Description the model reads for the `MergeBranch` tool. */
export const MERGE_BRANCH_DESCRIPTION =
  "Merge branch `from` into branch `into` of a location (a local merge, no push). This is the checked merge path; the " +
  "shell does not check git merge. `into` must be checked out already and granted for this goal (else OUT_OF_ENVELOPE: report " +
  "BLOCKED). A conflict aborts the merge and is reported.";
