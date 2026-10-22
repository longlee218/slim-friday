import type { Message } from "../chat/chat-types";
import { Icon } from "../ui/icon";
import { FileTile } from "./attachments";

type FileMsg = Extract<Message, { kind: "file" }>;
type TaskMsg = Extract<Message, { kind: "task" }>;

/** File a teammate saved for the owner. */
export function FileCard({ m }: { m: FileMsg }) {
  return <FileTile name={m.name} size={m.size} />;
}

/** Task progress reported by a teammate. */
export function TaskCard({ m }: { m: TaskMsg }) {
  return (
    <div className="card">
      <div className="card__head">
        <span className="card__glyph" data-tone="accent">
          <Icon name="run" />
        </span>
        <span className="card__text">
          <b>{m.title}</b>
          <span>{m.note}</span>
        </span>
        <span className="card__pct">{m.pct}%</span>
      </div>
      <div className="meter" role="progressbar" aria-valuenow={m.pct} aria-valuemin={0} aria-valuemax={100} aria-label={m.title}>
        <i style={{ width: `${m.pct}%` }} />
      </div>
    </div>
  );
}
