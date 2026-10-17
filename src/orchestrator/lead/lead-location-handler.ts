import { homedir } from "node:os";
import { REGISTER_LOCATION_TOOL } from "../../mcp/orchestration/tools/RegisterLocationTool/constants";
import { inspectLocation, type LocationCandidate } from "../../workspaces/location-candidate";
import { registerLocation } from "../../workspaces/register-location";
import { type Reply, refuse } from "../reply";
import { type LeadPlace, type LeadToolContext, leadCall } from "./lead-call";
import { REGISTER_LOCATION_MAX_PER_RUN } from "./lead-limits";
import type { RegisterLocationInput } from "./lead-schemas";
import { pathInText } from "./owner-path-match";

/* RegisterLocation handler: owner-only, path must be in the owner's message, one call per run, an owner click before
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

/**
 * RegisterLocation: refuse unless this is an owner run and the path is in the owner's message (prompt-injection guard),
 * at most one call per run, inspect the path, ask the owner Yes/No, then write yaml + link the channel and refresh the
 * run's location list. The audit row names the real path and the owner as grantor.
 */
export const handleRegisterLocation = (
  ctx: LeadToolContext,
  input: RegisterLocationInput,
  userHome: string = homedir(),
): Promise<Reply> =>
  leadCall(ctx, REGISTER_LOCATION_TOOL, input, async () => {
    const { place } = ctx;
    const path = input.path.trim();
    if (place?.trigger !== "owner" || !place.ownerText)
      return {
        reply: refuse(
          "NOT_OWNER_TURN",
          "A location is registered only on the owner's own message.",
        ),
      };
    if (!pathInText(path, place.ownerText, userHome))
      return {
        reply: refuse(
          "PATH_NOT_IN_MESSAGE",
          "The path is not in the owner's message: ask the owner to write the full path.",
        ),
      };
    if ((ctx.run.registered ?? 0) >= REGISTER_LOCATION_MAX_PER_RUN)
      return { reply: refuse("LIMIT", "One location per run: ask the owner again next message.") };
    ctx.run.registered = (ctx.run.registered ?? 0) + 1; // counted on attempt: a refused path is not retried in a loop
    const c = inspectLocation(place.home, place.workspace, path, userHome);
    if (!c.ok) return { reply: refuse("BAD_PATH", c.reason) };
    const a = await ctx.port.askOwner({ question: confirmText(c, place), options: ["Yes", "No"] });
    if (a.answer !== "Yes")
      return {
        reply: refuse("OWNER_DENIED", "The owner did not confirm: nothing was registered."),
      };
    const w = registerLocation(place.home, place.workspace, place.channelId, c, userHome);
    if (!w.ok) return { reply: refuse("WRITE_FAILED", w.reason) };
    place.refresh(); // the same run may now dispatch to it
    return {
      reply: { ok: true, location: w.name, path: c.realPath, git: c.git, linked: w.linked },
      audit: {
        scope: `${c.realPath} -> ${place.workspace}/${place.channel ?? place.channelId}`,
        grantedBy: "owner",
      },
    };
  });
