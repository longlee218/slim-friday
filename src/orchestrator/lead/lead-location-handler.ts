import { homedir } from "node:os";
import { readProcessEnv } from "../../config/process-env";
import { ORCHESTRATE_ACTION_REGISTER_LOCATION } from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { createProject, undoCreateProject } from "../../workspaces/create-project";
import { defaultProjectPath, defaultProjectsDir } from "../../workspaces/default-project-path";
import { inspectLocation, type LocationCandidate } from "../../workspaces/location-candidate";
import { registerLocation } from "../../workspaces/register-location";
import { loadWorkspaces } from "../../workspaces/workspace-registry";
import { type Reply, refuse } from "../reply";
import { type LeadPlace, type LeadToolContext, leadCall } from "./lead-call";
import { REGISTER_LOCATION_MAX_PER_RUN } from "./lead-limits";
import type { RegisterLocationInput } from "./lead-schemas";
import { pathInText } from "./owner-path-match";

/* Orchestrate register_location handler: owner-only, an owner-given path must be in the owner's message or an ask_owner answer (a create without path uses the channel's default projects dir), one call per run, an owner click before
   anything is written. It is config, not work: outside the per-goal envelope, asked every time, never a stored grant. */

/** Most sensitive names listed in the confirm text, and the longest one shown. */
const SENSITIVE_SHOWN = 3;
const NAME_CHARS = 60;
/* The confirm text must fit the approval prompt (SUMMARY_MAX, 1500): every line has its own cap, so the total stays
   below it by construction and the sensitive lines (the ones the owner must see) are never the ones clipped. */
const TITLE_CHARS = 160;
const PATH_CHARS = 600;
const OTHER_SPACES_CHARS = 200;
const SENSITIVE_LINE_CHARS = 280;

/** A name from the filesystem made safe for the confirm text (control chars and markdown marks out, clipped). */
const plain = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
  s.replace(/[\u0000-\u001f\u007f`*_~|>]/g, " ").slice(0, NAME_CHARS);

/** `s` cut to `max` chars with an ellipsis. */
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

/** A real path shown in a code span: control chars become visible `\xNN` escapes, backticks cannot close the span. */
const pathSpan = (p: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control chars is the point
  `\`${p.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`).replaceAll("`", "'")}\``;

/** The owner's confirm question: exactly what will be registered and what it allows. Pure; under 1500 chars. */
export function confirmText(
  c: LocationCandidate,
  place: Pick<LeadPlace, "workspace" | "channel">,
): string {
  const where = `${place.workspace}/${place.channel ?? "this channel"}`;
  const lines = [
    clip(
      c.existing
        ? `Link "${plain(c.existing)}" (already in ${place.workspace}) to ${where}?`
        : `Register "${plain(c.name)}" as a location of ${place.workspace} and let ${where} use it?`,
      TITLE_CHARS,
    ),
    clip(`Path: ${pathSpan(c.realPath)}`, PATH_CHARS),
    `Git repo: ${c.git ? "yes" : "no"}`,
  ];
  if (c.otherSpaces.length)
    lines.push(
      clip(`Warning: also used by ${c.otherSpaces.map(plain).join(", ")}.`, OTHER_SPACES_CHARS),
    );
  if (c.sensitive.length) {
    const names = c.sensitive.slice(0, SENSITIVE_SHOWN).map(plain).join(", ");
    const more = c.sensitive.length > SENSITIVE_SHOWN ? ", ..." : "";
    lines.push(
      clip(`Sensitive files: ${c.sensitive.length} (${names}${more})`, SENSITIVE_LINE_CHARS),
    );
  }
  if (c.sensitiveTruncated) lines.push("Sensitive search incomplete: the directory is large.");
  lines.push("Developer runs get full read/write here.");
  return lines.join("\n");
}

/** The default projects dir configured for the channel (channel entry, else workspace), or undefined. Re-read per call. */
function defaultDir(home: string, workspace: string, channelId: string): string | undefined {
  const ws = loadWorkspaces(home).workspaces.find((w) => w.name === workspace);
  return ws && defaultProjectsDir(ws, channelId);
}

/**
 * Orchestrate register_location: refuse unless this is an owner run and the path is in the owner's message (prompt-injection guard),
 * at most one call per run, inspect the path, ask the owner Yes/No, then write yaml + link the channel and refresh the
 * run's location list. The audit row names the real path and the owner as grantor.
 */
export const handleRegisterLocation = (
  ctx: LeadToolContext,
  input: RegisterLocationInput,
  userHome: string = readProcessEnv().HOME || homedir(), // HOME first: the same value, and a test can set it
): Promise<Reply> =>
  leadCall(ctx, ORCHESTRATE_ACTION_REGISTER_LOCATION, input, async () => {
    const { place } = ctx;
    if (input.path === undefined && !input.create)
      return { reply: refuse("PATH_REQUIRED", "register_location needs a path (or create:true).") };
    let path = input.path?.trim() ?? "";
    if (place?.trigger !== "owner" || !place.ownerText)
      return {
        reply: refuse(
          "NOT_OWNER_TURN",
          "A location is registered only on the owner's own message.",
        ),
      };
    if (input.path !== undefined) {
      // The owner's own words only: the message, or an answer to an ask_owner of this run (never worker text or memory).
      const ownerWords = [place.ownerText, ...(ctx.run.ownerAnswers ?? [])];
      if (!ownerWords.some((t) => pathInText(path, t, userHome)))
        return {
          reply: refuse(
            "PATH_NOT_IN_MESSAGE",
            "The path is not in the owner's message or answer: ask the owner to write the full path.",
          ),
        };
    }
    if ((ctx.run.registered ?? 0) >= REGISTER_LOCATION_MAX_PER_RUN)
      return { reply: refuse("LIMIT", "One location per run: ask the owner again next message.") };
    if (input.path === undefined) {
      // No path: default projects dir (owner-edited config, so no owner answer needed) + a slug name.
      const dir = defaultDir(place.home, place.workspace, place.channelId);
      if (!dir)
        return {
          reply: refuse(
            "NO_DEFAULT_PROJECTS_DIR",
            "No default projects dir is set for this channel: call ask_owner kind select with 2-3 candidate paths, then register_location create:true with the chosen path.",
          ),
        };
      const made = defaultProjectPath(dir, userHome, input.name, place.ownerText);
      if (!made.ok) return { reply: refuse(made.code, made.reason) };
      path = made.path;
    }
    // Counted once a path is resolved: a refusal for a missing default dir leaves the ask_owner fallback its one try.
    ctx.run.registered = (ctx.run.registered ?? 0) + 1;
    let created: Awaited<ReturnType<typeof createProject>> | undefined;
    if (input.create) {
      // New project: the owner's words or the configured default dir chose the path, so there is no second Yes/No.
      created = await createProject(place.home, userHome, path, place.ownerText);
      if (!created.ok) return { reply: refuse(created.code, created.reason) };
    }
    // A failure after a create removes what this call made (the project is not registered, so nothing would own it).
    const undo = () => created?.ok && undoCreateProject(created.path, created.made);
    const c = inspectLocation(place.home, place.workspace, path, userHome);
    if (!c.ok) {
      undo();
      return { reply: refuse("BAD_PATH", c.reason) };
    }
    if (!input.create) {
      const a = await ctx.port.askOwner({
        question: confirmText(c, place),
        options: ["Yes", "No"],
      });
      if (a.answer !== "Yes")
        return {
          reply: refuse("OWNER_DENIED", "The owner did not confirm: nothing was registered."),
        };
    }
    const w = registerLocation(place.home, place.workspace, place.channelId, c, userHome);
    if (!w.ok) {
      undo();
      return { reply: refuse("WRITE_FAILED", w.reason) };
    }
    place.refresh(); // the same run may now dispatch to it
    return {
      reply: {
        ok: true,
        location: w.name,
        path: c.realPath,
        git: c.git,
        linked: w.linked,
        ...(input.create && { created: true }),
      },
      audit: {
        scope: `${c.realPath} -> ${place.workspace}/${place.channel ?? place.channelId}`,
        grantedBy: "owner",
      },
    };
  });
