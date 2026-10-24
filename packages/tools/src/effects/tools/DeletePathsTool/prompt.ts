/** Description the model reads for `DeletePaths`. */
export const DELETE_PATHS_DESCRIPTION =
  "Delete files or dirs inside your workspaces by moving them to the trash (kept 7 days, the owner can restore them). " +
  "Paths must be absolute and inside a workspace; a workspace root, anything in the git dir and secret files are refused. " +
  "One refused path means nothing is deleted. Returns the trash dir.";
