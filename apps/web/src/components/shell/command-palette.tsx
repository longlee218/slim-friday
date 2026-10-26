import { Dialog } from "@base-ui/react/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
  CalendarClock,
  CalendarPlus,
  CircleStop,
  Files,
  Gauge,
  type LucideIcon,
  Plug,
  Plus,
  Puzzle,
  Search,
  Sparkles,
  SquareKanban,
  UserRound,
  Users,
} from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { useOpenNewTicket } from "../../app/shell-context";
import { refetchStatus } from "../../events/apply-effects";
import { useOpenNewSchedule } from "../schedules/use-open-new-schedule";
import { Avatar } from "../ui/avatar";
import { BottomSheet } from "../ui/bottom-sheet";
import { type PaletteContext, type PaletteItem, paletteItems } from "./palette-items";
import { useAppNavigate } from "./use-app-navigate";

/** Lucide icons by the names `palette-items.ts` uses. */
const ICONS: Record<string, LucideIcon> = {
  users: Users,
  plus: Plus,
  "calendar-clock": CalendarClock,
  "calendar-plus": CalendarPlus,
  files: Files,
  "square-kanban": SquareKanban,
  gauge: Gauge,
  "circle-stop": CircleStop,
  "user-round": UserRound,
  sparkles: Sparkles,
  plug: Plug,
  puzzle: Puzzle,
};

const GROUPS: PaletteItem["group"][] = ["Bots", "Groups", "Actions", "Settings"];

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Phone: render inside a bottom sheet instead of the centered panel. */
  asSheet?: boolean;
}

/** Case-insensitive substring match on the label (the value is `"<group>:<label>"`). */
const filter = (value: string, search: string) =>
  value
    .slice(value.indexOf(":") + 1)
    .toLowerCase()
    .includes(search.toLowerCase())
    ? 1
    : 0;

/** The search field and grouped rows; running an item closes the palette first. */
function PaletteBody({ onClose }: { onClose: () => void }) {
  const dir = useDirectory();
  const navigate = useAppNavigate();
  const qc = useQueryClient();
  const status = useQuery(orpc.control.status.queryOptions()).data;
  const newTicket = useOpenNewTicket();
  const newSchedule = useOpenNewSchedule();
  const items = useMemo(() => paletteItems(dir), [dir]);

  // `control.stop` takes a botId, so stop each working bot; one toast for the batch. Every stop
  // settles before the toast, and the status refetches either way (some bots may have stopped).
  const ctx: PaletteContext = {
    navigate,
    newTicket,
    newSchedule,
    stopAll: async () => {
      const working = (status ?? []).filter((s) => s.working);
      if (working.length === 0) {
        toast("No bot is working.");
        return;
      }
      const results = await Promise.allSettled(
        working.map((s) => client.control.stop({ botId: s.botId })),
      );
      const failed = results.some((r) => r.status === "rejected");
      toast(failed ? "Could not stop. Try again." : "Stopped every bot.");
      refetchStatus(qc);
    },
  };

  return (
    <Command label="Command palette" filter={filter} loop>
      <Search className="s-ico" size={18} strokeWidth={1.75} aria-hidden />
      <Command.Input placeholder="Search bots, groups, actions" aria-label="Search" autoFocus />
      <Command.List className="res">
        <Command.Empty className="grp">No results</Command.Empty>
        {GROUPS.map((g) => {
          const rows = items.filter((i) => i.group === g);
          if (rows.length === 0) return null;
          return (
            <Command.Group key={g} heading={g}>
              {rows.map((i) => {
                const Icon = i.icon ? ICONS[i.icon] : undefined;
                return (
                  <Command.Item
                    key={`${g}:${i.label}`}
                    value={`${g}:${i.label}`}
                    className="it"
                    onSelect={() => {
                      onClose();
                      i.run(ctx);
                    }}
                  >
                    {i.avatar !== undefined ? (
                      <Avatar src={i.avatar} name={i.label} size={22} />
                    ) : (
                      <span className="sb-ico">
                        {Icon && <Icon size={18} strokeWidth={1.75} />}
                      </span>
                    )}
                    <span>{i.label}</span>
                    {(i.shortcut ?? i.sub) && <span className="k">{i.shortcut ?? i.sub}</span>}
                  </Command.Item>
                );
              })}
            </Command.Group>
          );
        })}
      </Command.List>
    </Command>
  );
}

/**
 * Command palette (⌘K): bots, groups, actions and settings behind one search. Base UI `Dialog`
 * owns focus, the backdrop and Esc (the Dialog stops Esc, so the shell's Esc fallback that closes
 * floating panels does not also fire); `cmdk` owns filtering and arrow / Enter selection. On a
 * phone the same body sits in a `BottomSheet`.
 */
export function CommandPalette({ open, onOpenChange, asSheet }: CommandPaletteProps) {
  const close = () => onOpenChange(false);
  if (asSheet) {
    return (
      <BottomSheet open={open} onOpenChange={onOpenChange}>
        <div className="palette in-sheet">
          <PaletteBody onClose={close} />
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dim" />
        <Dialog.Popup className="palette" aria-label="Command palette">
          <PaletteBody onClose={close} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
