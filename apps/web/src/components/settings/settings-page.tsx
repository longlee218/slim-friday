import { type ReactNode, useRef } from "react";
import { useIsPhone } from "../../app/use-is-phone";
import { PhoneNavBar } from "../phone/phone-nav-bar";
import { useBackLabel } from "../phone/phone-shell";

/**
 * One settings screen. On desktop it is just its content (the layout supplies the frame); on
 * the phone it is a navigation page: nav bar (large title on the root, back button when
 * pushed) over a scroll area. `inset` pages bring their own side margins (inset lists).
 */
export function SettingsPage({
  title,
  inset,
  right,
  children,
}: {
  title: string;
  inset?: boolean;
  right?: ReactNode;
  children: ReactNode;
}) {
  const phone = useIsPhone();
  const scroll = useRef<HTMLDivElement>(null);
  const back = useBackLabel();
  if (!phone) return <>{children}</>;
  return (
    <>
      <PhoneNavBar title={title} large={!back} back={back} right={right} scrollRef={scroll} />
      <div className={back ? "ios-scroll nt" : "ios-scroll"} ref={scroll}>
        {!back && <div className="large">{title}</div>}
        {inset ? children : <div style={{ padding: "0 16px 16px" }}>{children}</div>}
      </div>
    </>
  );
}
