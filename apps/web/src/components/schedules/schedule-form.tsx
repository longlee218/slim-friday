import { MessageCircle, Users } from "lucide-react";
import { useDirectory } from "../../api/directory";
import { Row, Segmented } from "../settings/form-parts";
import { TicketSelect } from "../tickets/ticket-select";
import { Avatar } from "../ui/avatar";
import { REPEAT_KINDS, REPEAT_NAMES, type ScheduleFormValue } from "./schedule-form-state";
import { postTargets } from "./schedule-target";
import { ScheduleWhenRow } from "./schedule-when-row";

type V = ScheduleFormValue;

const NOTIFY_HELP: Record<V["notify"], string> = {
  always: "Each run posts its result and sends a notification.",
  problems: "Quiet runs stay in the log; you get a message only when the bot reports a problem.",
};

export interface ScheduleFormProps {
  value: V;
  set<K extends keyof V>(k: K, v: V[K]): void;
  /** Message per refused field. */
  errors: Partial<Record<keyof V, string>>;
  /** `create` lets the owner pick the bot, the chat and the time zone; they never change after. */
  mode: "create" | "edit";
  readOnly?: boolean;
}

/** Message bubble for a bot's own chat, people for a group. */
const ChatIcon = ({ id }: { id: string }) =>
  id.startsWith("group:") ? <Users strokeWidth={1.75} /> : <MessageCircle strokeWidth={1.75} />;

/**
 * One schedule's form (prototype `scheduleForm`): what, who, when, where, how loud. Shared by
 * the schedule page and the new-schedule sheet. Repeat has a fifth choice, Once (date + time);
 * there is no limit per run. Bot, Post to and time zone are pickers on create, text after.
 */
export function ScheduleForm(props: ScheduleFormProps) {
  const { value: v, set, errors, mode, readOnly } = props;
  const dir = useDirectory();
  const create = mode === "create";
  const targets = postTargets(v.botId, dir);
  const chatName = targets.find((t) => t.id === v.conversationId)?.name ?? v.conversationId;
  const botName = dir.botName(v.botId);
  const face = <Avatar src={dir.bots.get(v.botId)?.avatarUrl} name={botName} size={16} />;
  const chat = (
    <>
      <ChatIcon id={v.conversationId} />
      {chatName}
    </>
  );

  return (
    <div className="sched-form">
      <div className="formgroup">
        <Row label="Name" htmlFor="sc-name" error={errors.name}>
          <input
            id="sc-name"
            className={errors.name ? "field err" : "field"}
            maxLength={80}
            value={v.name}
            disabled={readOnly}
            onChange={(e) => set("name", e.target.value)}
          />
        </Row>
        <Row label="Bot">
          {create ? (
            <TicketSelect
              label="Bot"
              value={v.botId || null}
              options={[...dir.bots.values()].map((b) => ({
                value: b.id,
                node: (
                  <>
                    <Avatar src={b.avatarUrl} name={b.name} size={18} />
                    {b.name}
                  </>
                ),
              }))}
              current={
                v.botId ? (
                  <>
                    {face}
                    {botName}
                  </>
                ) : (
                  "Choose a bot"
                )
              }
              onChange={(id) => {
                set("botId", id);
                set("conversationId", `bot:${id}`);
              }}
            />
          ) : (
            <span className="sched-fixed">
              {face}
              {botName}
            </span>
          )}
        </Row>
        <Row
          label="Task"
          htmlFor="sc-task"
          top
          error={errors.task}
          help="Written like a message to the bot. It runs with the bot's own tools and memory."
        >
          <textarea
            id="sc-task"
            className={errors.task ? "field err" : "field"}
            rows={4}
            maxLength={4000}
            value={v.task}
            disabled={readOnly}
            onChange={(e) => set("task", e.target.value)}
          />
        </Row>
      </div>
      <div className="formgroup">
        <Row label="Repeat">
          <Segmented
            label="Repeat"
            options={REPEAT_KINDS}
            names={REPEAT_NAMES}
            value={v.repeat}
            disabled={readOnly}
            onChange={(k) => set("repeat", k)}
          />
        </Row>
        <ScheduleWhenRow {...props} />
        <Row label="Post to">
          {create ? (
            <TicketSelect
              label="Post to"
              value={v.conversationId}
              options={targets.map((t) => ({
                value: t.id,
                node: (
                  <>
                    <ChatIcon id={t.id} />
                    {t.name}
                  </>
                ),
              }))}
              current={chat}
              onChange={(id) => set("conversationId", id)}
            />
          ) : (
            <span className="sched-fixed">{chat}</span>
          )}
        </Row>
        <Row label="Tell me" help={NOTIFY_HELP[v.notify]}>
          <Segmented
            label="Tell me"
            options={["always", "problems"] as const}
            names={{ always: "Every run", problems: "Only problems" }}
            value={v.notify}
            disabled={readOnly}
            onChange={(n) => set("notify", n)}
          />
        </Row>
      </div>
    </div>
  );
}
