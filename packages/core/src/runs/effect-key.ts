import { inputHash } from "../permission/input-hash";

/**
 * The record key of one effect tool call made while run `wakeId` answers: the call's tool and exact input,
 * and `n`, this execution's count of identical calls (1 for the first). Same shape as `sendKeyFor`: a
 * re-execution after a cut counts from 1 again, so it finds the first call's record, while a deliberate
 * second identical call in one execution gets its own key. `cardId` changes per approval card, so calls
 * after a card resume are fresh. Async because the hash uses Web Crypto.
 */
export async function effectKeyFor(
  wakeId: string,
  cardId: string | undefined,
  tool: string,
  input: Record<string, unknown>,
  n: number,
): Promise<string> {
  return `${wakeId}:${cardId ?? "-"}:${tool}:${await inputHash(tool, input)}:${n}`;
}
