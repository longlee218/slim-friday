import type { ArtifactToolCtx } from "../../artifacts/artifact-access";
import type { TeammateRuntime, TeammateThreadCtx } from "./teammate-runtime";

/** Name and path of each location of the thread's channel (what MCP tool ctx parts carry). */
export const locationRefs = (ctx: TeammateThreadCtx): { name: string; path: string }[] =>
  ctx.locations.map((l) => ({ name: l.name, path: l.path }));

/** Artifact tools ctx of a run: the thread's channel scope, plus the run's own ids (`extra`). */
export const artifactCtx = (
  rt: TeammateRuntime,
  ctx: TeammateThreadCtx,
  threadId: string,
  role: string,
  extra: Partial<ArtifactToolCtx> = {},
): ArtifactToolCtx => ({
  db: rt.deps.db,
  home: rt.deps.config.agentHome,
  workspace: ctx.workspace,
  ...(ctx.channel && { channel: ctx.channel }),
  threadId,
  role,
  locations: locationRefs(ctx),
  ...extra,
});
