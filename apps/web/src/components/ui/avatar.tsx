/** Face used when a bot has no avatar of its own. */
const FALLBACK_SRC = "/avatars/lead.webp";

export interface AvatarProps {
  src?: string;
  name: string;
  /** Diameter in px (default 32). */
  size?: number;
  /** Adds the rotating 2 px tint arc (`.av.working::after`). */
  working?: boolean;
}

/** Round bot face; `name` is the alt text. */
export function Avatar({ src, name, size = 32, working }: AvatarProps) {
  return (
    <span className={working ? "av working" : "av"} style={{ width: size, height: size }}>
      <img src={src || FALLBACK_SRC} alt={name} />
    </span>
  );
}

export interface AvatarStackProps {
  /** `working` draws the rotating arc on that face, as `Avatar` does. */
  items: { src?: string; name: string; working?: boolean }[];
  size?: number;
  /** Faces shown before the rest are cut (default 4). */
  max?: number;
}

/** Overlapping faces (-6 px, from `.stack`). */
export function AvatarStack({ items, size = 24, max = 4 }: AvatarStackProps) {
  return (
    <span className="stack">
      {items.slice(0, max).map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat; the list is static
        <Avatar key={`${i}-${item.name}`} {...item} size={size} />
      ))}
    </span>
  );
}
