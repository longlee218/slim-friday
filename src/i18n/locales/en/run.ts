/* Notices about the state of a run (`notice-text-run.ts`). */
export const enRun = {
  "run.start": "On it.",
  "run.steer.queued": "Got it, I've passed that on to what's already running.",
  "run.steer.held":
    "Got it. I'll hand that over as soon as the current work is ready for it, so it isn't applied yet.",
  "run.steer.waiting":
    "Got it. I'm waiting on your answer above first, then I'll pass this on. Not applied yet.",
  "run.steer.full":
    "I can't take more right now, the queue is full, so that wasn't applied. Send it again in a bit?",
  "run.steer.resumed": "Thanks, got your answer. The work is picking back up.",
  "run.steer.ended": "That work just wrapped up, so your message didn't reach it. Send it again?",
  "run.queue.full": "The queue is full right now. Send this again once the current work is done.",
  "run.queue.received": "Got your request. I'll start it as soon as the current work is done.",
  "run.clarification.pending":
    "I'm not sure how that answers the question above. What would you like to do?",
  "run.clarification.ask": "Can you tell me a bit more about what you'd like me to do?",
  "run.replacement": "Stopping what I'm doing so I can pick up your new request.",
  "run.stop.active": "Stopping the current work.",
  "run.stop.idle": "Nothing is running.",
  "run.outcome.aborted": "Stopped.",
  "run.outcome.quota":
    "That didn't finish: the service is limiting requests at the moment. Try again in a little while.",
  "run.outcome.max_budget": "That didn't finish: it hit the spending limit.",
  "run.outcome.max_turns": "That didn't finish: it hit the processing limit for a single run.",
  "run.outcome.timeout": "That didn't finish: it took too long. You can send the request again.",
  "run.outcome.other": "I couldn't finish that one. Want to try again?",
  "run.outcome.retryAfter": " You can try again after {at}.",
  "run.failure.busy": "I'm busy with something else. Try again in a moment.",
  "run.failure.budget":
    "I haven't started because the spending limit has been reached. You can send a new request.",
  "run.failure.location":
    "I can't find the location you picked. Check the name, or pick another one.",
  "run.failure.approval": "I haven't started: Discord approvals need to be turned on first.",
  "run.failure.expired": "That request is no longer waiting, so nothing started. Send it again.",
  "run.failure.ceiling":
    "I haven't started: this work has used up its spending limit, and it can't be raised. Send a new request.",
  "run.failure.drain": "I'm updating right now. Try again in a moment.",
  "run.failure.validLocations": " Locations I know: {names}.",
  "run.note.no-delivery": "Heads up: nothing was committed, pushed or opened as a PR this time.",
  "run.note.empty-text": "Add a message with the task.",
  "run.note.stop-in-thread": "Send `/stop` inside the thread of the run.",
  "run.note.status-in-thread": "Send `/status` inside the thread of the run.",
  "run.note.not-allowed": "You can't use that command.",
  "run.note.channel-unavailable": "I can't use this channel right now. Try again.",
  "run.decision.confirm": "Want me to go ahead with what we just talked about?",
  "run.decision.gate": "Please use the buttons on the message above.",
  "run.decision.none": "There's no question waiting for your answer.",
  "run.decision.dropped": "Okay, dropped that request.",
  "run.decision.decline-busy": "I'm still on the current work. Answer again once it's done.",
} as const;
