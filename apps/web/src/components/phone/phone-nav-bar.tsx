import { ChevronLeft } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { usePhoneStack } from "./phone-shell";

/** Scroll distance (px) after which a large title collapses into the bar. */
const COLLAPSE_AT = 38;

export interface PhoneNavBarProps {
  title: string;
  /** Root tab: a 34 px title in the scroll body that collapses to the 17 px inline title. */
  large?: boolean;
  /** Label of the back button; its presence makes the bar a solid pushed-view bar. */
  back?: string;
  right?: ReactNode;
  /** The scroll container under the bar; its scrollTop drives the collapse. */
  scrollRef: RefObject<HTMLElement | null>;
}

/**
 * 44 px iOS bar. Root tabs start transparent with the large title below and turn translucent
 * with a hairline once scrolled past it; pushed views are solid with a tint back chevron.
 * Back pops the navigation stack.
 */
export function PhoneNavBar({ title, large, back, right, scrollRef }: PhoneNavBarProps) {
  const { back: pop } = usePhoneStack();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !large) return;
    const onScroll = () => setScrolled(el.scrollTop > COLLAPSE_AT);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef, large]);

  const solid = !large || scrolled;
  return (
    <div className={solid ? "ios-nav solid" : "ios-nav"}>
      {back ? (
        <button type="button" className="nb back" onClick={pop}>
          <ChevronLeft strokeWidth={1.75} />
          {back}
        </button>
      ) : (
        <span />
      )}
      <span className={large ? "ttl" : "ttl always"}>{title}</span>
      {right ?? <span />}
    </div>
  );
}
