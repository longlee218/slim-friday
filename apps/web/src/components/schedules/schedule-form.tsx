import { MessageCircle, Users } from "lucide-react";
import { useDirectory } from "../../api/directory";
import { Group, Row, Segmented } from "../settings/form-parts";
import { TicketSelect } from "../tickets/ticket-select";
import { Avatar } from "../ui/avatar";
import {
  localToday,
  REPEAT_KINDS,
  REPEAT_NAMES,
  type RepeatKind,
  type ScheduleFormValue,
} from "./schedule-form-state";
import { FORM_ERROR_ID, formError } from "./schedule-save";
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

/** The server's refusal under the form; Save points at it with aria-describedby. */
export function FormErrorLine({ errors }: { errors: object }) {
  const message = formError(errors);
  return message ? (
    <div id={FORM_ERROR_ID} className="help err sched-form-err" role="alert">
      {message}
    </div>
  ) : null;
}

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
  // A new Repeat drops the old kind's refusals (re-setting a field clears its error); Once
  // starts from today when it has no date yet.
  const repeat = (k: RepeatKind) => {
    set("repeat", k);
    for (const f of ["at", "every", "date"] as const) set(f, v[f]);
    if (k === "once" && !v.date) set("date", localToday());
  };
  const chat = (
    <>
      <ChatIcon id={v.conversationId} />
      {chatName}
    </>
  );

  return (
    <div className="sched-form">
      <Group>
        <Row label="Name" htmlFor="sc-name" error={errors.name}>
          <input
            id="sc-name"
            placeholder="Required"
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
      </Group>
      <Group
        title={<label htmlFor="sc-task">Task</label>}
        foot="Written like a message to the bot. It runs with the bot's own tools and memory."
        error={errors.task}
        wide
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
      </Group>
      <Group foot={NOTIFY_HELP[v.notify]}>
        <Row label="Repeat">
          <Segmented
            label="Repeat"
            options={REPEAT_KINDS}
            names={REPEAT_NAMES}
            value={v.repeat}
            disabled={readOnly}
            onChange={repeat}
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
        <Row label="Tell me">
          <Segmented
            label="Tell me"
            options={["always", "problems"] as const}
            names={{ always: "Every run", problems: "Only problems" }}
            value={v.notify}
            disabled={readOnly}
            onChange={(n) => set("notify", n)}
          />
        </Row>
      </Group>
    </div>
  );
}
