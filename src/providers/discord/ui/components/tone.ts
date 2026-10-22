/**
 * What a message means to the owner. Each tone has an accent color (the colored bar on the left of a Container), so an
 * alert, a question and a result are told apart at a glance. Discord fixes button colors (Success green, Danger red,
 * Primary blurple, Secondary grey); the accent color of a Container is free.
 */
export type Tone = "ask" | "ok" | "warn" | "error" | "info";

/** Accent color of a tone (24-bit RGB). */
export const TONE_COLOR: Record<Tone, number> = {
  ask: 0x5865f2, // blurple: a question waits for the owner
  ok: 0x57f287, // green: approved, done
  warn: 0xfee75c, // yellow: timed out, needs attention
  error: 0xed4245, // red: denied, failed
  info: 0x4f545c, // grey: neutral, cancelled
};
