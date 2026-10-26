import { GroupInputDtoSchema } from "@friday/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { client, orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { useIsPhone } from "../../app/use-is-phone";
import { Avatar } from "../ui/avatar";
import { AvatarPicker } from "./avatar-picker";
import { GroupAvatar } from "./group-avatar";
import { GroupForm, type GroupFormValue, NEW_GROUP } from "./group-form";
import { ChatAction, ProfileHead } from "./profile-head";
import { RuleList } from "./rule-list";
import { SettingsPage } from "./settings-page";
import { useHeldAvatar } from "./use-held-avatar";

/** `/settings/group/new`: the form of a group that does not exist yet. */
export function GroupNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const phone = useIsPhone();
  const avatar = useHeldAvatar();
  const onSave = async (v: GroupFormValue) => {
    const { id, ...group } = v;
    await client.config.groups.save({ id, group, mode: "create" });
    await avatar.saveHeld({ kind: "group", id });
    await qc.invalidateQueries({ queryKey: orpc.config.groups.key() });
    void navigate(`/settings/group/${id}`, { replace: true });
  };
  return (
    <SettingsPage title="New group">
      {/* The phone nav bar already names the page, so the head is the face alone there. */}
      <ProfileHead
        face={
          <AvatarPicker target={{ kind: "group", id: "" }} onHold={avatar.hold} onDone={() => {}}>
            {avatar.previewUrl ? (
              <Avatar src={avatar.previewUrl} name="New group" size={96} />
            ) : (
              <span className="av none" style={{ width: 96, height: 96 }}>
                <Users strokeWidth={1.5} />
              </span>
            )}
          </AvatarPicker>
        }
        title={phone ? undefined : "New group"}
        sub={phone ? undefined : "Bots that work together in one channel."}
      />
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
      <ProfileHead
        face={
          <AvatarPicker
            target={{ kind: "group", id: group.id }}
            current={group.avatar}
            onDone={() => {}}
          >
            <GroupAvatar {...group} bots={dir.bots} size={96} />
          </AvatarPicker>
        }
        title={group.name}
        sub={`${group.members.length} members`}
        actions={<ChatAction to={`/c/group:${group.id}`} />}
      />
      <GroupForm
        key={group.id}
        initial={{ ...GroupInputDtoSchema.parse(group), id: group.id }}
        mode="update"
        onSave={onSave}
      />
      <h3 className="grp-h">Group rules</h3>
      <RuleList owner={`group:${group.id}`} />
    </SettingsPage>
  );
}
