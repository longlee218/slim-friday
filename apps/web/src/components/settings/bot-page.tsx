import { BotInputDtoSchema } from "@friday/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { useRef } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { Avatar } from "../ui/avatar";
import { useSegThumb } from "../ui/use-seg-thumb";
import { AvatarPicker } from "./avatar-picker";
import { BotForm } from "./bot-form";
import { type BotFormValue, NEW_BOT } from "./bot-form-value";
import { SEG_BUTTON, SEG_GRID } from "./form-parts";
import { MemoryPanel } from "./memory-panel";
import { RuleList } from "./rule-list";
import { SettingsPage } from "./settings-page";

const TABS = [
  ["profile", "Profile"],
  ["tools", "Tools & skills"],
  ["memory", "Memory"],
  ["rules", "Rules"],
] as const;
/** Width of one tab (the tabs share the control equally). */

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
  const tabBox = useRef<HTMLDivElement>(null);
  const tabAt = TABS.findIndex(([t]) => t === tab);
  // The tab bar mounts once the bot loads: that is when it can be measured.
  const tabThumb = useSegThumb(tabBox, tabAt, TABS.length, bot ? "loaded" : "");
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
  /** Saves the owner's fields; a new name is toasted, since mentions follow it. */
  const save = async ({ id: _id, ...input }: BotFormValue) => {
    await client.config.bots.save({ id: bot.id, bot: input, mode: "update" });
    await qc.invalidateQueries({ queryKey: orpc.config.bots.key() });
    if (input.name !== bot.name) toast(`Mentions use @${input.name} now`);
  };
  const initial: BotFormValue = { ...BotInputDtoSchema.parse(bot), id: bot.id };
  return (
    <SettingsPage title={bot.name}>
      <div className="set-head">
        {shipped ? (
          <Avatar src={bot.avatarUrl} name={bot.name} size={64} />
        ) : (
          <AvatarPicker target={{ kind: "bot", id: bot.id }} current={bot.avatar} onDone={() => {}}>
            <Avatar src={bot.avatarUrl} name={bot.name} size={64} />
          </AvatarPicker>
        )}
        <div className="grow">
          <h2>{bot.name}</h2>
          <div className="r">{[bot.title, bot.model].filter(Boolean).join(" · ")}</div>
        </div>
        <Link className="btn" to={`/c/bot:${bot.id}`}>
          <MessageCircle size={14} strokeWidth={1.75} />
          Open chat
        </Link>
      </div>
      <div className="tabs">
        <div ref={tabBox} className="seg" style={SEG_GRID} role="tablist">
          {tabAt >= 0 && <span className="thumb" style={tabThumb} />}
          {TABS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "on" : ""}
              style={SEG_BUTTON}
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
          onSave={save}
        />
      ) : // Memory and rules are the owner's files, so a shipped bot's stay editable.
      tab === "rules" ? (
        <RuleList owner={`bot:${bot.id}`} />
      ) : (
        <MemoryPanel owner={`bot:${bot.id}`} />
      )}
    </SettingsPage>
  );
}
