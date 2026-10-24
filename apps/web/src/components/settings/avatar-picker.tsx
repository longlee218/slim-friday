import { Popover } from "@base-ui/react/popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Upload, Users } from "lucide-react";
import { type ChangeEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { useIsPhone } from "../../app/use-is-phone";
import { BottomSheet } from "../ui/bottom-sheet";
import { encodeAvatar, TOO_LARGE } from "./encode-avatar";

/** The bot or group whose avatar is changed. */
export interface AvatarTarget {
  kind: "bot" | "group";
  id: string;
}

export interface AvatarPickerProps {
  target: AvatarTarget;
  /** The saved avatar value (a preset name), to mark it. */
  current?: string;
  /** Called after the avatar is saved. */
  onDone: () => void;
  /** The face shown inside the trigger. */
  children: ReactNode;
}

type Status = "idle" | "uploading" | "too-large" | "failed";

/** Ten presets, Upload image and (groups) Member faces; popover on desktop, bottom sheet on phone. */
export function AvatarPicker({ target, current, onDone, children }: AvatarPickerProps) {
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
function PickerBody({ target, current, onDone }: Omit<AvatarPickerProps, "children">) {
  const qc = useQueryClient();
  const presets = useQuery(orpc.config.avatars.list.queryOptions()).data ?? [];
  const [status, setStatus] = useState<Status>("idle");
  const busy = status === "uploading";

  /** Saves the choice, then refreshes everything that shows a face. */
  const apply = async (choice: { preset: string } | { uploadId: string } | { none: true }) => {
    if (target.kind === "bot") {
      await client.config.bots.setAvatar({ id: target.id, ...(choice as { preset: string }) });
    } else {
      await client.config.groups.setAvatar({ id: target.id, ...choice });
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: orpc.config.bots.key() }),
      qc.invalidateQueries({ queryKey: orpc.config.groups.key() }),
      qc.invalidateQueries({ queryKey: orpc.conversations.key() }),
    ]);
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
      const { blob, type } = await encodeAvatar(file);
      const ticket = await client.config.avatars.create({
        kind: target.kind,
        id: target.id,
        size: blob.size,
        type,
      });
      const res = await fetch(ticket.putUrl, {
        method: "PUT",
        body: blob,
        headers: { "Content-Type": type },
        credentials: "omit",
      });
      if (!res.ok) throw new Error("put");
      await apply({ uploadId: ticket.uploadId });
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
            onClick={() => void run(() => apply({ preset: p.name }))}
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
            onClick={() => void run(() => apply({ none: true }))}
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
