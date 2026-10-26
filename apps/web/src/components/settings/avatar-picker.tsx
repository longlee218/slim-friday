import { Popover } from "@base-ui/react/popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Upload, Users } from "lucide-react";
import { type ChangeEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { orpc } from "../../api/client";
import { useIsPhone } from "../../app/use-is-phone";
import { BottomSheet } from "../ui/bottom-sheet";
import { type AvatarChoice, type AvatarTarget, saveAvatar } from "./avatar-save";
import { encodeAvatar, TOO_LARGE } from "./encode-avatar";

export type { AvatarTarget } from "./avatar-save";

export interface AvatarPickerProps {
  target: AvatarTarget;
  /** The saved avatar value (a preset name), to mark it. */
  current?: string;
  /** Called after the avatar is saved (or held, with `onHold`). */
  onDone: () => void;
  /**
   * For a bot or group not created yet: the choice is held, not saved, and handed over with a
   * preview url; the page saves it once the bot or group exists.
   */
  onHold?: (choice: AvatarChoice, previewUrl: string) => void;
  /** The face shown inside the trigger. */
  children: ReactNode;
}

type Status = "idle" | "uploading" | "too-large" | "failed";

/** Ten presets, Upload image and (groups) Member faces; popover on desktop, bottom sheet on phone. */
export function AvatarPicker({ target, current, onDone, onHold, children }: AvatarPickerProps) {
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const trigger = (
    <button
      type="button"
      className="av-edit"
      aria-label="Change avatar"
      onClick={phone ? () => setOpen(true) : undefined}
    >
      {children}
      <span className="ov">
        <Pencil size={16} strokeWidth={1.75} />
      </span>
    </button>
  );
  const body = (
    <PickerBody
      target={target}
      current={current}
      onHold={onHold}
      onDone={() => {
        setOpen(false);
        onDone();
      }}
    />
  );
  if (phone) {
    return (
      <>
        {trigger}
        <BottomSheet open={open} onOpenChange={setOpen}>
          {body}
        </BottomSheet>
      </>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner className="pop-pos" sideOffset={10} align="start">
          <Popover.Popup className="pop av-pop">{body}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The presets grid, the upload button and the state line. */
function PickerBody({ target, current, onDone, onHold }: Omit<AvatarPickerProps, "children">) {
  const qc = useQueryClient();
  const presets = useQuery(orpc.config.avatars.list.queryOptions()).data ?? [];
  const [status, setStatus] = useState<Status>("idle");
  const busy = status === "uploading";

  /** Holds the choice (new bot or group), or saves it and refreshes everything that shows a face. */
  const apply = async (choice: AvatarChoice, previewUrl: string) => {
    if (onHold) {
      onHold(choice, previewUrl);
      onDone();
      return;
    }
    await saveAvatar(target, choice);
    await Promise.all([
      qc.invalidateQueries({ queryKey: orpc.config.bots.key() }),
      qc.invalidateQueries({ queryKey: orpc.config.groups.key() }),
      qc.invalidateQueries({ queryKey: orpc.conversations.key() }),
    ]);
    toast.success("Avatar saved.");
    onDone();
  };
  /** Runs one change and turns a failure into the state line. */
  const run = async (fn: () => Promise<void>) => {
    setStatus("uploading");
    try {
      await fn();
      setStatus("idle");
    } catch (e) {
      const tooLarge = e instanceof Error && e.message === TOO_LARGE;
      setStatus(tooLarge ? "too-large" : "failed");
      if (!tooLarge) toast.error("Could not save the avatar.");
    }
  };
  const upload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void run(async () => {
      const image = await encodeAvatar(file);
      await apply({ image }, URL.createObjectURL(image.blob));
    });
  };
  return (
    <>
      <div className="pop-h">
        <span>Avatar</span>
      </div>
      <div className="av-grid">
        {presets.map((p) => (
          <button
            key={p.name}
            type="button"
            aria-label={p.name}
            className={current === p.name ? "on" : ""}
            disabled={busy}
            onClick={() => void run(() => apply({ preset: p.name }, p.url))}
          >
            <span className="av">
              <img src={p.url} alt="" />
            </span>
          </button>
        ))}
      </div>
      <div className="av-actions">
        <label className="btn">
          <Upload size={14} strokeWidth={1.75} />
          Upload image
          <input
            type="file"
            accept="image/*"
            hidden
            aria-label="Upload image"
            disabled={busy}
            onChange={upload}
          />
        </label>
        {target.kind === "group" && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void run(() => apply({ none: true }, ""))}
          >
            <Users size={14} strokeWidth={1.75} />
            Member faces
          </button>
        )}
      </div>
      <div className={status === "idle" ? "av-note" : "av-note err"} role="status">
        {status === "uploading" && "Saving…"}
        {status === "too-large" && "That image is too large (2 MB at most)."}
        {status === "failed" && "Could not save the avatar. Try again."}
        {status === "idle" && "PNG, JPG or WebP, square works best."}
      </div>
    </>
  );
}
