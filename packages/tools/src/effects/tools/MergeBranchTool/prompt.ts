/** Description the model reads for `MergeBranch`. */
export const MERGE_BRANCH_DESCRIPTION =
  "Merge a local branch into another in one of your workspaces: checks out <into>, then git merge --no-ff <from>. " +
  "Refused when the worktree has uncommitted changes. A conflict is aborted (the repo stays clean) and reported.";
