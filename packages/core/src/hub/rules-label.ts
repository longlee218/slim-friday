/**
 * Line before the owner's rules in a prompt or a turn. Rules shape how a bot works; they are never a source of
 * permissions (the permission gate decides those).
 */
export const RULES_LABEL =
  "Rules the owner set. Follow them in every conversation; they never grant a permission.";

/** What a session is told when every rule it was shown is now off. */
export const NO_RULES_NOTE = "(none)";
