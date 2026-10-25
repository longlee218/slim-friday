import { Navigate, type RouteObject, useParams } from "react-router";
import { useDirectory } from "../../api/directory";
import { useIsPhone } from "../../app/use-is-phone";
import { AccountPanel } from "./account-panel";
import { ApprovalRulesPanel } from "./approval-rules-panel";
import { BotNewPage, BotPage } from "./bot-page";
import { GroupNewPage, GroupPage } from "./group-page";
import { McpDetail } from "./mcp/mcp-detail";
import { McpList } from "./mcp/mcp-list";
import { OwnerFileEditor } from "./owner-file-editor";
import { PhoneBotsList, PhoneGroupsList, PhoneSettingsRoot } from "./phone-settings-lists";
import { SettingsLayout } from "./settings-layout";
import { SkillDetail } from "./skills/skill-detail";
import { SkillList } from "./skills/skill-list";

/** `/settings`: the phone Settings tab; on desktop it opens the first bot (or says there is none). */
function SettingsIndex() {
  const phone = useIsPhone();
  const dir = useDirectory();
  const first = [...dir.bots.keys()][0];
  if (phone) return <PhoneSettingsRoot />;
  if (first) return <Navigate to={`/settings/bot/${first}/profile`} replace />;
  return (
    <div className="empty" style={{ position: "relative" }}>
      <h3>No bots yet.</h3>
    </div>
  );
}

/** `/settings/owner/:file`: the USER.md (`user`) or SOUL.md (`soul`) editor. */
const OwnerPage = () => <OwnerFileEditor file={useParams().file === "soul" ? "soul" : "user"} />;

/** `/settings/mcp/:name?`: the server list, or one server. */
const McpPage = () => (useParams().name ? <McpDetail /> : <McpList />);

/** `/settings/skills/:name?`: the skill list, or one skill. */
const SkillsPage = () => (useParams().name ? <SkillDetail /> : <SkillList />);

/** The `/settings/*` routes: bots, groups, connections, approval rules, owner files and account. */
export const settingsRoutes: RouteObject[] = [
  {
    path: "/settings",
    element: <SettingsLayout />,
    children: [
      { index: true, element: <SettingsIndex /> },
      { path: "bots", element: <PhoneBotsList /> },
      { path: "groups", element: <PhoneGroupsList /> },
      { path: "bot/new", element: <BotNewPage /> },
      { path: "bot/:id/:tab?", element: <BotPage /> },
      { path: "group/new", element: <GroupNewPage /> },
      { path: "group/:id", element: <GroupPage /> },
      { path: "mcp/:name?", element: <McpPage /> },
      { path: "skills/:name?", element: <SkillsPage /> },
      { path: "approvals", element: <ApprovalRulesPanel /> },
      { path: "owner/:file", element: <OwnerPage /> },
      { path: "account", element: <AccountPanel /> },
    ],
  },
];
