import { GroupInputDtoSchema } from "@friday/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { client, orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { AvatarPicker } from "./avatar-picker";
import { GroupAvatar } from "./group-avatar";
import { GroupForm, type GroupFormValue, NEW_GROUP } from "./group-form";
import { SettingsPage } from "./settings-page";

/** `/settings/group/new`: the form of a group that does not exist yet. */
export function GroupNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const onSave = async (v: GroupFormValue) => {
    const { id, ...group } = v;
    await client.config.groups.save({ id, group, mode: "create" });
    await qc.invalidateQueries({ queryKey: orpc.config.groups.key() });
    void navigate(`/settings/group/${id}`, { replace: true });
  };
  return (
    <SettingsPage title="New group">
      <div className="page-head">
        <div className="grow">
          <h2>New group</h2>
          <div className="r">Bots that work together in one channel.</div>
        </div>
      </div>
      <GroupForm initial={NEW_GROUP} mode="create" onSave={onSave} />
    </SettingsPage>
  );
}

/** `/settings/group/:id`: a group's head and its form. */
export function GroupPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const dir = useDirectory();
  const q = useQuery(orpc.config.groups.get.queryOptions({ input: { id } }));
  const group = q.data;
  if (!group) {
    return (
      <SettingsPage title="Group">
        <div className="empty">
          <h3>{q.isError ? "This group does not exist." : "Loading…"}</h3>
        </div>
      </SettingsPage>
    );
  }
  const onSave = async ({ id: _id, ...input }: GroupFormValue) => {
    await client.config.groups.save({ id: group.id, group: input, mode: "update" });
    await qc.invalidateQueries({ queryKey: orpc.config.groups.key() });
  };
  return (
    <SettingsPage title={group.name}>
      <div className="page-head">
        <AvatarPicker
          target={{ kind: "group", id: group.id }}
          current={group.avatar}
          onDone={() => {}}
        >
          <GroupAvatar {...group} bots={dir.bots} size={64} />
        </AvatarPicker>
        <div className="grow">
          <h2>{group.name}</h2>
          <div className="r">{group.members.length} members</div>
        </div>
        <Link className="btn" to={`/c/group:${group.id}`}>
          <MessageCircle size={14} strokeWidth={1.75} />
          Open chat
        </Link>
      </div>
      <GroupForm
        key={group.id}
        initial={{ ...GroupInputDtoSchema.parse(group), id: group.id }}
        mode="update"
        onSave={onSave}
      />
    </SettingsPage>
  );
}
