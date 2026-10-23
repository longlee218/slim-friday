import { createHash } from "node:crypto";
import type { Teammate } from "./teammate-types";

/**
 * The config a Claude session was started with, as a short hash: model, tools, skills and preset. A teammate session is
 * resumed only when its stored mark equals the current one; any change (a new model, a tool added) starts a fresh session,
 * so a session never continues under a different tool set or model than it began with.
 */
export function configMark(t: Pick<Teammate, "model" | "tools" | "skills" | "preset">): string {
  const canon = JSON.stringify([t.model, [...t.tools].sort(), [...t.skills].sort(), t.preset]);
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}
