/** The note under the approval rules: what a scheduled run reads without asking. */
export function ScheduledRunsNote() {
  return (
    <div className="foot-note">
      Scheduled runs read web pages and read-only connector tools without asking, even where a rule
      says Require approval.
    </div>
  );
}
