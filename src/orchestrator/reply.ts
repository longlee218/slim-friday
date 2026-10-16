/** A tool reply: facts on success, a code + message on refusal. Leaf module (imports nothing). */
export type Reply =
  | { ok: true; [k: string]: unknown }
  | { ok: false; code: string; message: string };

/** A coded refusal. */
export const refuse = (code: string, message: string): Reply => ({ ok: false, code, message });
