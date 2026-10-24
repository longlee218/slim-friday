import { eventIterator } from "@orpc/contract";
import { z } from "zod";
import { base } from "../errors";
import { FridayEventSchema } from "../events";

/** The live event stream; `lastEventId` resumes after a reconnect. */
export const events = {
  subscribe: base
    .input(z.object({ lastEventId: z.number().int().optional() }))
    .output(eventIterator(FridayEventSchema)),
};
