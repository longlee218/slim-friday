import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { useIsPhone } from "../../app/use-is-phone";
import { PhoneNavBar } from "../phone/phone-nav-bar";
import { useBackLabel } from "../phone/phone-shell";

/** The nav bar's right slot on a phone settings page (null off the phone or when the page fills it). */
const NavSlotContext = createContext<HTMLElement | null>(null);

/** Where a form portals its nav-bar Save on the phone (see SaveBar); null when there is none. */
export const useNavSlot = (): HTMLElement | null => useContext(NavSlotContext);

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
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  if (!phone) return <>{children}</>;
  // The page's own `right` wins; otherwise a form inside may portal its Save into the bar.
  const bar = right ?? <span className="nav-slot" ref={setSlot} />;
  return (
    <NavSlotContext.Provider value={right ? null : slot}>
      <PhoneNavBar title={title} large={!back} back={back} right={bar} scrollRef={scroll} />
      <div className={back ? "ios-scroll nt" : "ios-scroll"} ref={scroll}>
        {!back && <div className="large">{title}</div>}
        {inset ? children : <div style={{ padding: "0 16px 16px" }}>{children}</div>}
      </div>
    </NavSlotContext.Provider>
  );
}
