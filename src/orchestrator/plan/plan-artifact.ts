import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { indexArtifact } from "../../artifacts/artifact-index";
import { writeArtifact } from "../../artifacts/artifact-writer";
import { writeFileAtomic } from "../../artifacts/safe-write";
import type { ViewerConfig } from "../../config/viewer-config";
import { logger } from "../../observability/logger";
import { errText, redactText } from "../../observability/redact";
import { ftsDelete, setArtifactSize } from "../../storage/artifact-list-store";
import { listByGoal } from "../../storage/artifact-store";
import { childrenOf } from "../../storage/owned-item-store";
import { getThread } from "../../storage/thread-store";
import { type PlanStatus, planIdOfGoal, planVersions } from "../../storage/work-plan-store";
import { signedArtifactUrl } from "../../viewer/signed-link";
import { selectWorkspace } from "../../workspaces/task-workspace";
import { docOfRow } from "./plan-doc";
import { renderPlan } from "./plan-render";

/* Every plan version of a goal is a markdown artifact of the thread's channel, found by its title (no extra column).
   It is created once and rewritten in place when its text changes (status, item progress), each time a reader asks
   (`syncPlanArtifacts`): the viewer link, `/plan`, the digest and the revision line always show the current state. */

const log = logger.child({ module: "plan-artifact" });

/** What the readers of the plan artifacts need. */
export interface PlanViewDeps {
  db: Database;
  /** AGENT_HOME. */
  home: string;
  /** Absent = the viewer is off: no link. */
  viewer?: ViewerConfig | undefined;
}

/** One stored version as `/plan`, the digest and the lead read it. */
export interface PlanVersionInfo {
  version: number;
  status: PlanStatus;
  reason: string | null;
  createdAt: number;
  /** Artifact id; null when the thread has no workspace channel or the write failed. */
  artifactId: string | null;
}

/** Title (unique per goal and version) of a version's artifact. */
const titleOf = (goalId: string, version: number): string =>
  `Plan ${goalId.slice(0, 8)} v${version}`;

/** Workspace and channel (yaml name) of a thread, or undefined when its Discord channel is not mapped. */
function scopeOfThread(d: PlanViewDeps, threadId: string) {
  const row = getThread(d.db, threadId);
  if (!row) return undefined;
  const picked = selectWorkspace(d.home, row.channel_id);
  return "reply" in picked
    ? undefined
    : { workspace: picked.ws.name, channel: picked.channel.name };
}

/**
 * Create the missing plan artifacts of a goal and refresh the changed ones; returns every version (oldest first) with
 * its artifact id. Never throws: a failed write leaves `artifactId` null (or the old file) and is logged.
 */
export function syncPlanArtifacts(
  d: PlanViewDeps,
  threadId: string,
  goalId: string,
): PlanVersionInfo[] {
  const planId = planIdOfGoal(d.db, goalId);
  if (!planId) return [];
  const itemStatus = new Map(childrenOf(d.db, goalId).map((i) => [i.itemKey ?? i.id, i.status]));
  // Only artifacts this module made are reused or rewritten: a worker's or a repo's file with a plan-like title is not.
  const existing = new Map(
    listByGoal(d.db, goalId)
      .filter((a) => a.origin === "store" && a.kind === "md" && a.producerRole === null)
      .map((a) => [a.title, a]),
  );
  const scope = scopeOfThread(d, threadId);
  return planVersions(d.db, planId).map((row) => {
    const title = titleOf(goalId, row.version);
    const info: PlanVersionInfo = {
      version: row.version,
      status: row.status,
      reason: row.reason,
      createdAt: row.createdAt,
      artifactId: null,
    };
    try {
      const body = redactText(
        renderPlan(
          { version: row.version, objective: row.objective, doc: docOfRow(row) },
          {
            status: row.status,
            reason: row.reason,
            ...(row.status === "approved" && { itemStatus }),
          },
        ),
      );
      let old = existing.get(title);
      let current: string | undefined;
      if (old) {
        try {
          current = readFileSync(old.path, "utf8");
        } catch (err) {
          // The file is gone (purged): make a fresh artifact instead of linking a dead id.
          log.warn({ err: errText(err), goalId, version: row.version }, "plan artifact file lost");
          old = undefined;
        }
      }
      if (old) {
        info.artifactId = old.id;
        if (current !== body) {
          writeFileAtomic(d.home, dirname(old.path), basename(old.path), body);
          d.db.transaction(() => {
            ftsDelete(d.db, old.id);
            indexArtifact(d.db, old, body);
            setArtifactSize(d.db, old.id, Buffer.byteLength(body));
          })();
        }
      } else if (scope) {
        info.artifactId = writeArtifact(d.db, d.home, {
          ...scope,
          goalId,
          threadId,
          title,
          kind: "md",
          body,
        }).id;
      }
    } catch (err) {
      log.warn({ err: errText(err), goalId, version: row.version }, "plan artifact failed");
    }
    return info;
  });
}

/** The version a reader should open: the newest approved one (the plan in force), else the newest. */
export const currentVersion = (v: readonly PlanVersionInfo[]): PlanVersionInfo | undefined =>
  [...v].reverse().find((x) => x.status === "approved") ?? v[v.length - 1];

/** Signed viewer link of the goal's current plan artifact; undefined when the viewer is off or there is none. */
export function planUrl(d: PlanViewDeps, versions: readonly PlanVersionInfo[]): string | undefined {
  const id = currentVersion(versions)?.artifactId;
  return d.viewer && id ? signedArtifactUrl(d.viewer, id) : undefined;
}

/** Sync the goal's plan artifacts and return the link of the current one (the one call most readers need). */
export const planUrlOfGoal = (d: PlanViewDeps, threadId: string, goalId: string) =>
  planUrl(d, syncPlanArtifacts(d, threadId, goalId));

/** Label of the plan link button. */
const PLAN_LINK_LABEL = "Open plan";

/** The link button of a plan (`postTo` option); none without a URL. */
export const planLinks = (url: string | undefined): { label: string; url: string }[] =>
  url ? [{ label: PLAN_LINK_LABEL, url }] : [];
