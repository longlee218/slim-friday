/** Description the model reads for the `DeletePaths` tool. */
export const DELETE_PATHS_DESCRIPTION =
  "Delete files or directories by moving them to the trash (kept 7 days, restorable by the owner). The only way to " +
  "delete: rm, rmdir and find -delete are denied in the shell. paths: absolute paths inside the goal's locations " +
  "(a location root, .git, secret files and anything outside are refused). reason: why. Past the goal's bounds " +
  "(200 paths, 50 GB) the owner is asked. Codes: FORBIDDEN_PATH, OVER_BOUNDS, OWNER_DENIED, PARTIAL.";
