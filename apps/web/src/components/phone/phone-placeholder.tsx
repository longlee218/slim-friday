import { useRef } from "react";
import { PhoneNavBar } from "./phone-nav-bar";
import { useBackLabel } from "./phone-shell";

/** Phone stand-in for a screen a later plan builds: root tabs get a large title, pushed pages a back button. */
export function PhonePlaceholder({ title }: { title: string }) {
  const scroll = useRef<HTMLDivElement>(null);
  const back = useBackLabel();
  return (
    <>
      <PhoneNavBar title={title} large={!back} back={back} scrollRef={scroll} />
      <div className="ios-scroll" ref={scroll}>
        {!back && <div className="large">{title}</div>}
        <div className="empty">
          <h3>{title} is not built yet.</h3>
        </div>
      </div>
    </>
  );
}
