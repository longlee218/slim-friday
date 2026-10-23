import type { ImageAttachment, InboundMessage } from "../../ingress/inbound-message";
import type { ReportLink } from "../../ingress/report-links";
import type { Location } from "../../locations/location-registry";
import type { DispatchDeps } from "../run/role-run-types";
import type { QuestionRelay } from "../worker/question-relay";

/* What the teammate runtime (teammate run, dispatch-ready, announce) shares: the deps of a run and the facts of a thread. */

/** What the runtime knows about a thread: where it lives and how to speak in it. Built from the owner's last message. */
export interface TeammateThreadCtx {
  workspace: string;
  /** Channel (yaml name) of the thread's channel. */
  channel?: string;
  channelMode?: "task" | "chat";
  channelId: string;
  /** Locations of that channel (a worker's `location` must be one of them). */
  locations: Location[];
  /** The owner's last message: language, source and the Discord channel the teammate's reply is posted to (`notify`). */
  message: InboundMessage;
}

/** The teammate runtime: shared deps and the late-bound pieces (the announcer and the queue need each other). */
export interface TeammateRuntime {
  deps: DispatchDeps;
  /** Facts of a thread, or undefined when none is known (the thread was never seen in this process and is not in the db). */
  ctxOf(threadId: string): TeammateThreadCtx | undefined;
  /** Re-read the thread's locations from workspace.yaml (after `Orchestrate register_location` wrote one). */
  refresh(threadId: string): void;
  /** Wake the teammate for new news of the thread (batched by the announcer; `delayMs` 0 = now, for urgent news such as a blocker). */
  announce(threadId: string, delayMs?: number): void;
  relay: QuestionRelay;
}

/** Post text into the thread; a failure is returned to the caller as a rejected promise. */
export const postTo = (
  ctx: TeammateThreadCtx,
  text: string,
  opts?: { asFile?: boolean; fileName?: string; links?: ReportLink[]; image?: ImageAttachment },
): Promise<void> => (ctx.message.notify ? ctx.message.notify(text, opts) : Promise.resolve());
