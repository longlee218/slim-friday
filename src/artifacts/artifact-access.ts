import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { redactText } from "../observability/redact";
import { isInside, resolveReal } from "../policy/paths";
import { isSensitivePath } from "../runtime/sensitive-files";
import { type ArtifactFilter, listChannelArtifacts } from "../storage/artifact-list-store";
import { type ArtifactRow, getArtifact } from "../storage/artifact-store";
import type { ArtifactKind } from "./artifact-kinds";
import {
  ARTIFACT_LIST_MAX,
  ARTIFACT_READ_PAGE_CHARS,
  ARTIFACT_SEARCH_DEFAULT_LIMIT,
  ARTIFACT_SEARCH_MAX_LIMIT,
} from "./artifact-limits";
import { readRepoText } from "./artifact-repo-sync";
import { type ArtifactHit, searchArtifacts } from "./artifact-search";
import { writeArtifact } from "./artifact-writer";

/**
 * What the artifact tools know about the run they belong to. The scope (workspace + channel) comes from the run, never
 * from the model: a run sees the artifacts of its own channel only (the boundary of channel memory).
 */
export interface ArtifactToolCtx {
  db: Database;
  /** AGENT_HOME: store artifacts live under it. */
  home: string;
  workspace: string;
  /** Channel (yaml name) of the run; absent = the workspace level (stored as ''). */
  channel?: string;
  /** Lookup columns stamped on what the run saves. */
  threadId?: string;
  goalId?: string;
  taskId?: string;
  /** Role name of the run (producer of what it saves). */
  role?: string;
  /** Locations of the run's channel: a repo artifact is read through its location. */
  locations: { name: string; path: string }[];
  /** The run's own granted location: the only one a repo doc may be reported from. */
  granted?: { name: string; path: string };
}

/** A refusal (same shape as the orchestration `Reply`; this module imports nothing of it). */
export type Refused = { ok: false; code: string; message: string };
const refuse = (code: string, message: string): Refused => ({ ok: false, code, message });
const NOT_FOUND = refuse("NOT_FOUND", "No such artifact in this channel.");

/** Channel key of a run: its yaml name, '' at the workspace level. */
const channelOf = (c: ArtifactToolCtx): string => c.channel ?? "";

/** The artifact when it belongs to the run's channel, else null (an unknown id and another channel's id look the same). */
export function scopedArtifact(c: ArtifactToolCtx, id: string): ArtifactRow | null {
  const row = getArtifact(c.db, id);
  return row && row.workspace === c.workspace && row.channel === channelOf(c) ? row : null;
}

/** Row of a listing: what the model needs to pick an artifact. */
const summary = (a: ArtifactRow) => ({
  id: a.id,
  title: a.title,
  kind: a.kind,
  origin: a.origin,
  version: a.version,
  createdAt: new Date(a.createdAt).toISOString(),
});

/** `since` (YYYY-MM-DD) as epoch ms; undefined when absent, NaN-safe (a bad day is dropped by the schema regex). */
const sinceMs = (day?: string): number | undefined =>
  day ? Date.parse(`${day}T00:00:00Z`) : undefined;

/** Artifacts of the run's channel, newest first (at most `ARTIFACT_LIST_MAX`). */
export function listArtifacts(c: ArtifactToolCtx, f: Omit<ArtifactFilter, "since"> = {}) {
  const rows = listChannelArtifacts(c.db, c.workspace, channelOf(c), {
    ...f,
    limit: ARTIFACT_LIST_MAX,
  });
  return { ok: true as const, artifacts: rows.map(summary) };
}

/** Keyword search over the run's channel (one hit per artifact, best chunk as the snippet). */
export function searchChannel(
  c: ArtifactToolCtx,
  q: { query: string; goalId?: string; threadId?: string; since?: string; limit?: number },
) {
  const limit = Math.min(
    Math.max(q.limit ?? ARTIFACT_SEARCH_DEFAULT_LIMIT, 1),
    ARTIFACT_SEARCH_MAX_LIMIT,
  );
  const since = sinceMs(q.since);
  const { hits, terms } = searchArtifacts(c.db, c.workspace, {
    query: q.query,
    channel: channelOf(c),
    limit,
    ...(q.goalId !== undefined && { goalId: q.goalId }),
    ...(q.threadId !== undefined && { threadId: q.threadId }),
    ...(since !== undefined && { since }),
  });
  if (terms === 0) return refuse("INVALID_INPUT", "The query has no searchable word.");
  const rows = hits.map((h: ArtifactHit) => ({
    id: h.artifactId,
    title: h.title,
    snippet: redactText(h.snippet),
  }));
  return { ok: true as const, hits: rows };
}

/** The whole text of an artifact, or null when it cannot be read as text (html, a location the run lacks, a bad file). */
function artifactText(c: ArtifactToolCtx, a: ArtifactRow): string | null {
  if ((a.kind as ArtifactKind) === "html") return null;
  if (a.origin === "store") {
    // A store path is app-written; it is re-checked anyway (a row must never lead outside AGENT_HOME).
    const real = resolveReal(a.path);
    if (!isInside(resolveReal(c.home), real)) return null;
    return redactText(readFileSync(real, "utf8"));
  }
  const loc = c.locations.find((l) => l.name === a.location);
  if (!loc) return null;
  const root = resolveReal(loc.path);
  const real = resolveReal(join(root, a.path));
  if (
    isInside(resolveReal(c.home), real) ||
    !isInside(root, real) ||
    isSensitivePath(a.path) ||
    isSensitivePath(relative(root, real))
  )
    return null;
  if (!statSync(real).isFile()) return null;
  return readRepoText(c.db, a, real);
}

/**
 * One page of an artifact: `limit` chars (at most `ARTIFACT_READ_PAGE_CHARS`) from `offset`. The page bounds one tool
 * result, not the artifact: `nextOffset` tells where the next page starts (null at the end). An html artifact, or one
 * the run cannot read, gives its metadata only.
 */
export function readArtifact(c: ArtifactToolCtx, id: string, offset = 0, limit?: number) {
  const a = scopedArtifact(c, id);
  if (!a) return NOT_FOUND;
  const meta = { ...summary(a), size: a.size };
  const text = artifactText(c, a);
  if (text === null)
    return {
      ok: true as const,
      ...meta,
      text: null,
      note: "Metadata only: this artifact is not readable as text here.",
    };
  const start = Math.min(Math.max(offset, 0), text.length);
  let end = Math.min(
    start + Math.min(Math.max(limit ?? ARTIFACT_READ_PAGE_CHARS, 1), ARTIFACT_READ_PAGE_CHARS),
    text.length,
  );
  // Never cut a surrogate pair (an emoji) in two.
  if (end < text.length && /[\ud800-\udbff]/.test(text.charAt(end - 1))) end--;
  return {
    ok: true as const,
    ...meta,
    offset: start,
    totalChars: text.length,
    nextOffset: end < text.length ? end : null,
    text: text.slice(start, end),
  };
}

/** Save a document artifact in the run's channel (through the phase-3 writer; no size cap). */
export function saveArtifact(
  c: ArtifactToolCtx,
  a: { title: string; kind: ArtifactKind; body: string },
) {
  const w = writeArtifact(c.db, c.home, {
    workspace: c.workspace,
    ...(c.channel && { channel: c.channel }),
    ...(c.goalId && { goalId: c.goalId }),
    ...(c.taskId && { taskId: c.taskId }),
    ...(c.threadId && { threadId: c.threadId }),
    ...(c.role && { producerRole: c.role }),
    title: a.title,
    fallbackName: "artifact",
    kind: a.kind,
    body: a.body,
  });
  return { ok: true as const, id: w.id, version: w.version };
}
