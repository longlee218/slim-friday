import type { InboundMessage } from "../../ingress/discord-message-handler";
import type { Location } from "../../locations/location-registry";
import type { DispatchDeps } from "../run/role-run-types";
import type { QuestionRelay } from "../worker/question-relay";

/* What the lead runtime (lead run, dispatch-ready, announce) shares: the deps of a run and the facts of a thread. */

/** What the runtime knows about a thread: where it lives and how to speak in it. Built from the owner's last message. */
export interface LeadThreadCtx {
  workspace: string;
  /** Channel (yaml name) of the thread's channel. */
  channel?: string;
  channelMode?: "task" | "chat";
  channelId: string;
  /** Locations of that channel (a worker's `location` must be one of them). */
  locations: Location[];
  /** The owner's last message: language, source and the Discord channel the lead's reply is posted to (`notify`). */
  message: InboundMessage;
}

/** The lead runtime: shared deps and the late-bound pieces (the announcer and the queue need each other). */
export interface LeadRuntime {
  deps: DispatchDeps;
  /** Facts of a thread, or undefined when none is known (the thread was never seen in this process and is not in the db). */
  ctxOf(threadId: string): LeadThreadCtx | undefined;
  /** Wake the lead for new news of the thread (batched by the announcer). */
  announce(threadId: string): void;
  relay: QuestionRelay;
  /** Resolves when the thread's rollover work (flush, summary) is done: a lead run never resumes a session being rolled. */
  hold?(threadId: string): Promise<void>;
  /** The run's reply is posted: the thread's rollover work (flush, summary) may start. */
  afterRun?(message: InboundMessage, turnId: string, workspace: string): void;
}

/** Post text into the thread; a failure is returned to the caller as a rejected promise. */
export const postTo = (ctx: LeadThreadCtx, text: string): Promise<void> =>
  ctx.message.notify ? ctx.message.notify(text) : Promise.resolve();
