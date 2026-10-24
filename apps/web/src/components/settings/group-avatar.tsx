import type { BotDto } from "@friday/contracts";
import { Avatar, AvatarStack } from "../ui/avatar";

export interface GroupAvatarProps {
  name: string;
  /** The group's own face; when set it wins over the member faces. */
  avatarUrl?: string;
  members: string[];
  bots: Map<string, BotDto>;
  /** Diameter of the own face, or of each member face (default 22). */
  size?: number;
}

/** A group's face: its own avatar, else the first three members' faces overlapping. */
export function GroupAvatar({ name, avatarUrl, members, bots, size = 22 }: GroupAvatarProps) {
  if (avatarUrl) return <Avatar src={avatarUrl} name={name} size={size} />;
  const items = members.slice(0, 3).map((id) => ({
    src: bots.get(id)?.avatarUrl,
    // Decorative: the group's name already labels the row.
    name: "",
  }));
  return <AvatarStack items={items} size={Math.round(size * 0.75)} max={3} />;
}
