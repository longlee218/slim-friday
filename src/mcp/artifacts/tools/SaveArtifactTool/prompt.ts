/** Description the model reads for the `SaveArtifact` tool. */
export const SAVE_ARTIFACT_DESCRIPTION =
  "Save a deliverable for the owner (a summary you wrote, a combined report, a spec) as an artifact of this channel: title (short, descriptive), kind (md | html | diff | csv | txt) and the full body. A worker's result and files become artifacts when you call forward; do not copy them here. " +
  'A status note, a progress update, a blocker or a "done" message is not an artifact: send it with Report. ' +
  "The file is written to the agent store (not to a project). " +
  "There is no size limit. Same title again = a new version, the old one stays. Returns the artifact id " +
  "(name it in briefs; other runs read it by id).";
