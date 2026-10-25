/**
 * Names of the avatar presets the web bundle ships (`/avatars/<name>.webp`). Owner-made presets in
 * `<AGENT_HOME>/config/avatars` have no image in the bundle, so the API never maps them to a URL.
 */
export const SHIPPED_PRESETS: readonly string[] = [
  "designer",
  "developer",
  "devops",
  "hacker",
  "humanizer",
  "lead",
  "planner",
  "researcher",
  "scouter",
  "tester",
];
