/** Description the model reads for the `CreatePullRequest` tool. */
export const CREATE_PULL_REQUEST_DESCRIPTION =
  "Open a pull request with gh from a pushed feature branch (head) into base. This is the checked PR path; the " +
  "shell does not check gh pr create. The location and head must be granted for this goal (else OUT_OF_ENVELOPE: " +
  "report a blocker). Returns the pull request URL.";
