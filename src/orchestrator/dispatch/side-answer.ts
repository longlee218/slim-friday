import type { Effort, TaskClass } from "../../config/model-routing";
import { stripAttachmentPaths } from "../../ingress/attachment-text";
import type { InboundMessage } from "../../ingress/discord-message-handler";
import { messageLanguage } from "../../ingress/user-copy";
import type { Location } from "../../locations/location-registry";
import { logEvent, logger, setLogContext } from "../../observability/logger";
import { threadLedger } from "../../storage/ledger-store";
import { runRole } from "../engine/run-role";
import { runRoute } from "../message-routing";
import { closeTurn } from "../turns/turn-result";
import { beginTurn, failTurn } from "../turns/turn-tracker";
import type { DispatchDeps } from "./dispatch-role";
import { threadReference } from "./thread-reference";
import { validateRequest } from "./validate-request";

/* The side lane: an independent question for a FOREGROUND role (not background, no writes) sent while the thread's task runs
   is answered at once, in a second read-only run next to the task. It shares NOTHING that a second run would break:
   - not the thread lock (the handler never takes it for a side run);
   - not the thread's session row (it starts fresh, never resumes, and saves no session: `sessionId` is dropped);
   - not the thread's task rows (its row lives under `<thread>:side`, so the thread state and the ledger of the
     running task are untouched);
   - not the task's steer input (a side run gets no steer hook, so it never registers a sink under the thread).
   It runs the role itself with the role's own budget, locations and guards (read-only). Limits: no conversation
   continuity (the context is the owner text, the recent messages and the task ledger), and its answer is not part
   of the thread's session, so a later turn of the assistant does not remember it. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "side-answer" });

/** Suffix of the thread id the side run's turn row is stored under (keeps it out of the thread's own rows). */
export const SIDE_THREAD_SUFFIX = ":side";

/** One side question. */
export interface SideInput {
  role: string;
  /** Owner text without prefixes. */
  text: string;
  location?: string;
  cls?: TaskClass;
  effort?: Effort;
  /** The message (thread, source, recent conversation). */
  message: InboundMessage;
  workspace: string;
  /** Channel (yaml name) the run started in: persona, memory and `Remember` scope `channel`. */
  channel?: string;
  locations: Location[];
  pinned?: Location;
  /** Controller of this side run (linked to the thread's `/stop` and to shutdown by the caller). */
  ac: AbortController;
  /** Status of the thread's running task (see tasks/status-snapshot.ts), shown to the role as data; empty = none. */
  snapshot?: string;
}

/** Answer a side question; returns the reply text. Throws only on a crash (the caller reports it). */
export async function runSideAnswer(deps: DispatchDeps, i: SideInput): Promise<string> {
  const { db, config } = deps;
  const brief = stripAttachmentPaths(i.text);
  // Data blocks (earlier tasks, recent conversation) go to the system context, never into the brief.
  const reference = threadReference(db, i.message.threadId, i.message.recent);
  const v = await validateRequest(
    {
      db,
      config,
      locations: i.locations,
      pinned: i.pinned,
    },
    { role: i.role, brief, location: i.location, cls: i.cls },
  );
  if (!v.ok) return v.refusal.reply;
  const { role } = v;
  const turnId = crypto.randomUUID();
  const sideThread = `${i.message.threadId}${SIDE_THREAD_SUFFIX}`;
  setLogContext({ taskId: turnId }); // log schema key kept
  beginTurn(
    db,
    log,
    { turnId, threadId: sideThread, source: i.message.source },
    { location: v.locationName, brief, cls: v.cls, role: role.name },
  );
  logEvent(log, "side.started", { role: role.name, location: v.locationName });
  const t0 = Date.now();
  const res = await runRole(
    { ...deps, steer: undefined }, // no steer hook: the side run must never register a sink under the thread
    {
      turnId,
      threadId: i.message.threadId, // approvals and the attachment copy belong to the real thread
      text: brief,
      language: messageLanguage(i.message),
      onVisible: i.message.visible,
      role: role.name,
      workspace: i.workspace,
      channel: i.channel,
      channelId: i.message.channelId,
      locations: role.locationScope === "all" ? i.locations : v.candidates,
      ac: i.ac,
      route: runRoute({ cls: i.cls, effort: i.effort }),
      pinned: i.pinned,
      existing: undefined, // fresh: never resumes (nor overwrites) the thread's session
      // The status snapshot goes with the ledger: both are data blocks of the running task.
      ledger: [
        i.snapshot,
        ...reference,
        role.context?.ledger ? threadLedger(db, i.message.threadId) : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ).catch((err: unknown) => {
    failTurn(db, log, turnId);
    throw err;
  });
  // `sessionId` dropped: closing the row must not save a session for the thread.
  return closeTurn(
    db,
    { turnId, threadId: sideThread },
    { ...res, sessionId: undefined },
    {
      language: messageLanguage(i.message),
      stopping: deps.stopping(),
      t0,
      location: v.locationName,
      locations: i.locations,
    },
  );
}
