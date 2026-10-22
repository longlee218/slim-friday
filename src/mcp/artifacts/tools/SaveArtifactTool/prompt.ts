/** Description the model reads for the `SaveArtifact` tool. */
export const SAVE_ARTIFACT_DESCRIPTION =
  "Save a deliverable the owner asked for (a report, a design, a prototype, a spec, a diff) as an artifact of this channel: title (short, descriptive), kind (md | html | diff | csv | txt) and the full body. " +
  'A status note, a progress update, a blocker or a "done" message is not an artifact: send it with Report. ' +
  "In a run with a project location the file is written to <location>/docs/friday/ (not committed), else to the agent store. " +
  "There is no size limit. Same title again = a new version, the old one stays. Returns the artifact id " +
  "(name it in your report and in briefs; the owner and other runs read it by id).";
