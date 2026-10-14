/**
 * Reply text that is never posted: the handler reacts with the done emoji on the owner message instead
 * (a steer notice already sent for the same thread and state within the dedupe window).
 * Neutral module: no discord.js import, so the orchestrator can use it.
 */
export const STEER_REACT_REPLY = "\u0000steer-react";
