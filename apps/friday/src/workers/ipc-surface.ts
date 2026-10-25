import type {
  Activity,
  Author,
  CardRow,
  Clock,
  ConversationId,
  FileStore,
  InboundMessage,
  Log,
  OutboundMessage,
  RunStep,
  Store,
  Surface,
} from "@friday/core";
import { postBotFile } from "@friday/surface-web";
import type { WorkerToMain } from "./ipc-protocol";

/** What the worker's surface needs. */
export interface IpcSurfaceDeps {
  /** Sends one message to main; may throw when the channel is closed. */
  send: (m: WorkerToMain) => void;
  /** The engine db (a bot's file is recorded there before it is posted). */
  store: Pick<Store, "messages" | "files">;
  /** The file store a bot's file is put on. */
  files: FileStore;
  clock: Clock;
  log: Log;
}

/**
 * The `Surface` of a worker process. Everything that must not be lost is already in the db when this is
 * called (the hub stores a message before `post`, a card before `showCard`); this only tells main, which reads
 * the row and publishes it on the web. Activity and run steps are live only and travel as they are. A worker
 * never receives owner messages (`onMessage` is never called back). A failed send is logged, never thrown:
 * the row stays, and the web shows it on its next load.
 */
export class IpcSurface implements Surface {
  constructor(private d: IpcSurfaceDeps) {}

  /** Owner messages arrive at main only. */
  onMessage(_handler: (m: InboundMessage) => Promise<number | undefined>): void {}

  /** The message is stored: main reads it by id and publishes it. */
  async post(conversationId: ConversationId, m: OutboundMessage): Promise<void> {
    this.tell({ t: "post", messageId: m.id, conversationId });
  }

  /** The card is stored: main shows it from the row. */
  showCard(card: CardRow, _botName: string): void {
    this.tell({ t: "card", cardId: card.id });
  }

  /** The card's row changed (answered or withdrawn): main closes it from the row. */
  closeCard(card: CardRow): void {
    this.tell({ t: "card", cardId: card.id });
  }

  /** Live typing / subagent sign. */
  showActivity(conversationId: ConversationId, activity: Activity): void {
    this.tell({ t: "activity", conversationId, activity });
  }

  /** Live finished notice (final answer posted to the owner). */
  notifyFinished(e: { conversationId: ConversationId; botId: string; preview: string }): void {
    this.tell({ t: "finished", ...e });
  }

  /** Live run step. */
  showRun(conversationId: ConversationId, botId: string, step: RunStep): void {
    this.tell({ t: "run_step", conversationId, botId, step });
  }

  /** Put the file on the file store, record it, then post its message (which reaches main as `post`). */
  postFile(
    conversationId: ConversationId,
    author: Author,
    file: { path: string; name: string },
    caption?: string,
  ): Promise<void> {
    return postBotFile({ ...this.d, surface: this }, conversationId, author, file, caption);
  }

  /** Send to main; a closed channel is logged (the worker is shutting down). */
  private tell(m: WorkerToMain): void {
    try {
      this.d.send(m);
    } catch (e) {
      this.d.log.warn({ t: m.t, err: String(e) }, "worker.ipc_send_failed");
    }
  }
}
