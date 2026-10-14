import { join } from "node:path";
import { workspacePaths } from "../../config/workspace-paths";
import { CHANNEL_CHARS, PER_LOCATION_CHARS, WORKSPACE_CHARS } from "../../memory/location-memory";
import { localDay, localHhmm } from "../../memory/memory-clock";
import { saveJournalBullet, saveMemoryBullet } from "../../memory/memory-section-writer";
import { DEFAULT_KIND, KIND_HEADING, type MemoryKind } from "../../memory/memory-sections";
import { channelTarget, locationTarget, workspaceTarget } from "../../memory/memory-targets";
import { PENDING_HEADER } from "../../memory/memory-writer";
import type { MemoryToolContext } from "../memory-tool-context";
import {
  REMEMBER_MAX_CHARS,
  REMEMBER_MIN_CHARS,
  REMEMBER_PENDING_CAP_CHARS,
  type RememberScope,
} from "./constants";

/** Arguments of one `Remember` call (already shape-checked by zod). */
export interface RememberArgs {
  text: string;
  scope: RememberScope;
  location?: string;
  kind?: MemoryKind;
}

/** Outcome: the text the model reads, whether it is an error, and the short result word for the log. */
export interface RememberOutcome {
  text: string;
  isError: boolean;
  result: string;
}

const fail = (text: string, result: string): RememberOutcome => ({ text, isError: true, result });

/** Refusal text for a failed write (the model relays it; `full` tells it what the owner does). */
const WRITE_ERRORS: Record<string, string> = {
  full: "memory file is full: ask the owner to run `compact memory`, then try again",
  busy: "memory file is busy: try again in a moment",
  symlink: "memory file is a symlink: refused",
  empty: "nothing left to save after cleaning the text",
};

/**
 * Save one note. `now` is read ONCE by the caller: the file date and the bullet date come from the same instant.
 * Pure of state except the file write; never throws for a bad argument (returns an error outcome).
 */
export function rememberNote(ctx: MemoryToolContext, a: RememberArgs, now: Date): RememberOutcome {
  const text = a.text.trim();
  if (text.length < REMEMBER_MIN_CHARS) return fail("text too short", "too_short");
  if (text.length > REMEMBER_MAX_CHARS)
    return fail(`text too long (max ${REMEMBER_MAX_CHARS} chars): shorten it`, "too_long");
  const kind = a.kind ?? DEFAULT_KIND;
  if (kind === "open" && a.scope !== "journal")
    return fail("kind open is only for scope journal", "bad_kind");
  if (a.location !== undefined && a.scope !== "location")
    return fail("location is only for scope location", "bad_location");

  const date = localDay(now);
  const fields = { workspace: ctx.workspace };
  const ws = workspacePaths(ctx.home).workspace(ctx.workspace);
  let file: string;
  let where: string;
  let save: () => ReturnType<typeof saveMemoryBullet>;
  switch (a.scope) {
    case "location": {
      const names = ctx.locationNames();
      // Exact registry match only: the name is never joined into a path otherwise.
      if (!a.location || !names.includes(a.location))
        return fail(
          `unknown location: valid locations are ${names.join(", ") || "(none)"}`,
          "bad_location",
        );
      const t = locationTarget(ctx.home, ctx.workspace, a.location);
      [file, where] = [t.file, `location/${a.location}`];
      save = () =>
        saveMemoryBullet(t.file, t.template, kind, text, date, PER_LOCATION_CHARS, {
          ...fields,
          location: a.location,
        });
      break;
    }
    case "channel": {
      if (!ctx.channel) return fail("this run has no channel: use scope workspace", "no_channel");
      const t = channelTarget(ctx.home, ctx.workspace, ctx.channel);
      [file, where] = [t.file, `channel/${ctx.channel}`];
      save = () =>
        saveMemoryBullet(t.file, t.template, kind, text, date, CHANNEL_CHARS, {
          ...fields,
          channel: ctx.channel,
        });
      break;
    }
    case "workspace": {
      const t = workspaceTarget(ctx.home, ctx.workspace);
      [file, where] = [t.file, "workspace"];
      save = () => saveMemoryBullet(t.file, t.template, kind, text, date, WORKSPACE_CHARS, fields);
      break;
    }
    case "global": {
      // Quarantine: the root MEMORY.md stays owner-only, the owner promotes notes by hand.
      file = workspacePaths(ctx.home).memoryPending;
      where = "global";
      // Origin stamp so the owner can tell where a queued note came from (the writer cuts the stamped text at its own limit).
      const origin = `[${ctx.workspace}${ctx.location ? `/${ctx.location}` : ""}] `;
      save = () =>
        saveMemoryBullet(
          file,
          PENDING_HEADER,
          kind,
          origin + text,
          date,
          REMEMBER_PENDING_CAP_CHARS,
          fields,
        );
      break;
    }
    case "journal": {
      file = join(ws.root, "memory", `${date}.md`);
      where = "journal";
      const slot = { hhmm: localHhmm(now), label: ctx.threadLabel };
      save = () => saveJournalBullet(file, slot, kind, text, date, fields);
      break;
    }
  }
  const res = save();
  if (res === "duplicate") return { text: "already saved", isError: false, result: res };
  if (res === "full" && a.scope === "global")
    return fail(
      "the review queue MEMORY.pending.md is full: ask the owner to promote or delete entries there",
      res,
    );
  if (res !== "saved") return fail(WRITE_ERRORS[res] ?? res, res);
  ctx.onSaved?.(file);
  return {
    text: `saved to ${where} (${KIND_HEADING[kind]})`,
    isError: false,
    result: res,
  };
}
