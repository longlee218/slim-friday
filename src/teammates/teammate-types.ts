/* A persistent teammate: the owner-visible record (a `teammates` row, parsed). Leaf file: types only. */

/** One teammate. */
export interface Teammate {
  id: string;
  /** Short unique name, how other teammates address it. */
  name: string;
  /** Public profile (what the other teammates see). */
  description: string;
  /** Discord channel id; the workspace and channel names come from `workspace.yaml`. */
  channelId: string;
  /** Preset it was created from. */
  preset: string;
  model: string;
  /** Catalog tool ids (valid for a teammate run). */
  tools: string[];
  skills: string[];
  /** Per-run budget in USD; undefined = the preset's. */
  budgetUsd?: number;
  /** Per-run turn ceiling; undefined = the preset's. */
  maxTurns?: number;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms archived; undefined = active. */
  archivedAt?: number;
}

/** A teammate name: lowercase letters, digits and dashes (it addresses the teammate in a peer message). */
export const TEAMMATE_NAME_RE = /^[a-z0-9-]{2,32}$/;
