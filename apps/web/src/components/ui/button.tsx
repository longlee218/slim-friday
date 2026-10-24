import type { ButtonHTMLAttributes } from "react";

/** Join class names, skipping falsy values. */
const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual role; `secondary` is the plain `.btn`. */
  variant?: "primary" | "secondary" | "danger";
  /** `lg` is the 36 px form used in sheets. */
  size?: "md" | "lg";
}

/** Text button using the prototype `.btn` classes (disabled look comes from the CSS). */
export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("btn", variant !== "secondary" && variant, size === "lg" && "lg", className)}
      {...rest}
    />
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  /** Pressed/active state (tint colour). */
  on?: boolean;
}

/** Square icon button (`.ib`); children is the lucide icon. */
export function IconButton({ label, on, className, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx("ib", on && "on", className)}
      {...rest}
    />
  );
}
