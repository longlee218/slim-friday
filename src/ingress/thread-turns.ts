/**
 * Messages of one thread reach `handleMessage` in the order they arrived: reading attachments and the history takes a
 * different time per message, so without this a quick second message could overtake the first (a steer or a queued
 * task in the wrong order). `takeTurn(thread).wait` resolves when every earlier message of the thread has made its
 * `handleMessage` call; `done` (idempotent) lets the next one go.
 */
export function createThreadTurns() {
  /** thread id -> end of the previous message's phase before its `handleMessage` call. */
  const turns = new Map<string, Promise<void>>();
  return function takeTurn(threadId: string): { wait: Promise<void>; done: () => void } {
    const prev = turns.get(threadId) ?? Promise.resolve();
    let done!: () => void;
    const mine = new Promise<void>((r) => (done = r));
    turns.set(threadId, mine);
    void mine.then(() => {
      if (turns.get(threadId) === mine) turns.delete(threadId);
    });
    return { wait: prev, done };
  };
}
