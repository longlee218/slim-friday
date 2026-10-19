/** Description the model reads for the `GitPush` tool. */
export const GIT_PUSH_DESCRIPTION =
  "Push one local branch of a location to a remote. This is the checked push path; the shell does not check git push. Never " +
  "forced. The location and branch must be granted for this goal (else OUT_OF_ENVELOPE: report a blocker). A push to " +
  "a default branch (main, master) asks the owner at every call.";
