/** Description the model reads for the `CreatePullRequest` tool. */
export const CREATE_PULL_REQUEST_DESCRIPTION =
  "Open a pull request with gh from a pushed feature branch (head) into base. The only way to open one: gh pr " +
  "create is denied in the shell. The location and head must be granted for this goal (else OUT_OF_ENVELOPE: " +
  "report BLOCKED). Returns the pull request URL.";
