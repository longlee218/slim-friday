/** Description the model reads for the `MergeBranch` tool. */
export const MERGE_BRANCH_DESCRIPTION =
  "Merge branch `from` into branch `into` of a location (a local merge, no push). The only way to merge: git merge is " +
  "denied in the shell. `into` must be checked out already and granted for this goal (else OUT_OF_ENVELOPE: report " +
  "BLOCKED). A conflict aborts the merge and is reported.";
