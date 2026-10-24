import type { BotDto } from "@friday/contracts";
import { Avatar } from "../ui/avatar";

/** Members whose name starts with the typed query (already lower-cased). */
export function matchMembers(members: BotDto[], query: string): BotDto[] {
  return members.filter((b) => b.name.toLowerCase().startsWith(query));
}

export interface MentionPopoverProps {
  members: BotDto[];
  groupName: string;
  entryId: string;
  query: string;
  selected: number;
  onPick(b: BotDto): void;
}

/**
 * The member list above the composer. Keys are handled by the textarea (the popover never
 * takes focus); a mouse pick uses mousedown so the textarea keeps its caret.
 */
export function MentionPopover({
  members,
  groupName,
  entryId,
  query,
  selected,
  onPick,
}: MentionPopoverProps) {
  const shown = matchMembers(members, query);
  if (!shown.length) return null;
  return (
    <div className="mention-pop" role="listbox" aria-label="Members">
      <div className="grp">{`Members of ${groupName}`}</div>
      {shown.map((b, i) => (
        <div
          key={b.id}
          role="option"
          tabIndex={-1}
          aria-selected={i === selected}
          className={i === selected ? "it on" : "it"}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(b);
          }}
        >
          <Avatar src={b.avatarUrl} name={b.name} size={22} />
          <span>{b.name}</span>
          <span className="r">{b.id === entryId ? `entry · ${b.title}` : b.title}</span>
        </div>
      ))}
    </div>
  );
}
