import { PanelLeft } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { IconButton } from "../ui/button";
import { NavButtons } from "./nav-buttons";
import { usePanels } from "./use-responsive-panels";

export interface ToolbarProps {
  title: ReactNode;
  actions?: ReactNode;
  /** Centre slot; Task 9 passes `<ActivityCapsule />` here. */
  capsule?: ReactNode;
}

/** 52 px translucent toolbar: sidebar toggle + history buttons, title, capsule slot, actions. */
export function Toolbar({ title, actions, capsule }: ToolbarProps) {
  const { toggle } = usePanels();
  const ref = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  // Hairline once the pane's `.content` scrolls; scroll does not bubble, so listen in capture.
  useEffect(() => {
    const pane = ref.current?.parentElement;
    if (!pane) return;
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement;
      if (el.classList?.contains("content")) setScrolled(el.scrollTop > 4);
    };
    pane.addEventListener("scroll", onScroll, true);
    return () => pane.removeEventListener("scroll", onScroll, true);
  }, []);

  return (
    <div ref={ref} className={`toolbar${scrolled ? " scrolled" : ""}`}>
      <span className="tb-lead">
        <IconButton label="Toggle sidebar (⌘0)" onClick={() => toggle("sidebar")}>
          <PanelLeft size={16} strokeWidth={1.75} />
        </IconButton>
        <NavButtons />
      </span>
      <div className="tb-title">{title}</div>
      <div className="tb-capsule">{capsule}</div>
      <div className="tb-actions">{actions}</div>
    </div>
  );
}
