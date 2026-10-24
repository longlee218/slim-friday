import { BotInputDtoSchema } from "@friday/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { client, orpc } from "../../api/client";
import { Avatar } from "../ui/avatar";
import { BotForm } from "./bot-form";
import { type BotFormValue, NEW_BOT } from "./bot-form-value";
import { InlineName } from "./inline-name";
import { SettingsPage } from "./settings-page";
import { SettingsPlaceholder } from "./settings-placeholder";

const TABS = [
  ["profile", "Profile"],
  ["tools", "Tools & skills"],
  ["memory", "Memory"],
  ["rules", "Rules"],
] as const;
/** Width of one tab (the tabs share the control equally). */
const TAB_W = `calc((100% - 4px) / ${TABS.length})`;

/** `/settings/bot/new`: the Profile form of a bot that does not exist yet. */
export function BotNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { tab } = useParams();
  const onSave = async (v: BotFormValue) => {
    const { id, ...bot } = v;
    await client.config.bots.save({ id, bot, mode: "create" });
    await qc.invalidateQueries({ queryKey: orpc.config.bots.key() });
    void navigate(`/settings/bot/${id}/profile`, { replace: true });
  };
  return (
    <SettingsPage title="New bot">
      <div className="set-head">
        <div className="grow">
          <h2>New bot</h2>
          <div className="r">Fill in the profile, then add tools and skills.</div>
        </div>
      </div>
      <BotForm
        initial={NEW_BOT}
        mode="create"
        tab={tab === "tools" ? "tools" : "profile"}
        onSave={onSave}
      />
    </SettingsPage>
  );
}

/** `/settings/bot/:id/:tab?`: a bot's head (face, rename, open chat), its tabs and the tab's body. */
export function BotPage() {
  const { id = "", tab = "profile" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery(orpc.config.bots.get.queryOptions({ input: { id } }));
  const bot = q.data;
  if (!bot) {
    return (
      <SettingsPage title="Bot">
        <div className="empty">
          <h3>{q.isError ? "This bot does not exist." : "Loading…"}</h3>
        </div>
      </SettingsPage>
    );
  }
  const shipped = bot.shipped === true;
  const tabAt = TABS.findIndex(([t]) => t === tab);
  /** Saves the owner's fields; the name always comes from the latest bot (rename has its own door). */
  const save = async (input: Omit<BotFormValue, "id">, name = bot.name) => {
    await client.config.bots.save({ id: bot.id, bot: { ...input, name }, mode: "update" });
    await qc.invalidateQueries({ queryKey: orpc.config.bots.key() });
  };
  const initial: BotFormValue = { ...BotInputDtoSchema.parse(bot), id: bot.id };
  return (
    <SettingsPage title={bot.name}>
      <div className="set-head">
        <Avatar src={bot.avatarUrl} name={bot.name} size={64} />
        <div className="grow">
          <InlineName
            value={bot.name}
            disabled={shipped}
            onSave={(name) => save(BotInputDtoSchema.parse(bot), name)}
          />
          <div className="r">{[bot.title, bot.model].filter(Boolean).join(" · ")}</div>
        </div>
        <Link className="btn" to={`/c/bot:${bot.id}`}>
          <MessageCircle size={14} strokeWidth={1.75} />
          Open chat
        </Link>
      </div>
      <div className="tabs">
        <div className="seg" style={{ display: "flex" }} role="tablist">
          {tabAt >= 0 && (
            <span
              className="thumb"
              style={{ left: `calc(2px + ${tabAt} * ${TAB_W})`, width: TAB_W }}
            />
          )}
          {TABS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "on" : ""}
              style={{ flex: "1 1 0" }}
              onClick={() => void navigate(`/settings/bot/${bot.id}/${t}`)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === "tools" || tab === "profile" ? (
        <BotForm
          key={bot.id}
          initial={initial}
          mode="update"
          tab={tab}
          shipped={shipped}
          onSave={({ id: _id, name: _name, ...input }) => save(input)}
        />
      ) : (
        <SettingsPlaceholder title={tab === "rules" ? "Rules" : "Memory"} />
      )}
    </SettingsPage>
  );
}
