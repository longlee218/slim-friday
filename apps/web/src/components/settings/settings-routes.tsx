import { Navigate, type RouteObject, useParams } from "react-router";
import { useDirectory } from "../../api/directory";
import { useIsPhone } from "../../app/use-is-phone";
import { BotNewPage, BotPage } from "./bot-page";
import { GroupNewPage, GroupPage } from "./group-page";
import { McpDetail } from "./mcp/mcp-detail";
import { McpList } from "./mcp/mcp-list";
import { PhoneBotsList, PhoneGroupsList, PhoneSettingsRoot } from "./phone-settings-lists";
import { SettingsLayout } from "./settings-layout";
import { SettingsPage } from "./settings-page";
import { SettingsPlaceholder } from "./settings-placeholder";

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

/** A page whose body a later task builds. */
const later = (title: string) => (
  <SettingsPage title={title}>
    <SettingsPlaceholder title={title} />
  </SettingsPage>
);

/** `/settings/mcp/:name?`: the server list, or one server. */
const McpPage = () => (useParams().name ? <McpDetail /> : <McpList />);

/** The `/settings/*` routes: bot and group forms now; MCP, skills, owner files and account later. */
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
      { path: "skills/:name?", element: later("Skills & plugins") },
      { path: "owner/:file", element: later("About you") },
      { path: "account", element: later("Account") },
    ],
  },
];
