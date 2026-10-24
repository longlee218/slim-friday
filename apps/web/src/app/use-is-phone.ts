import { PANEL_MIN } from "../components/shell/panels";
import { useWidth } from "../lib/use-media";

/** True below the phone breakpoint (640 px); follows resizes. */
export const useIsPhone = (): boolean => useWidth() < PANEL_MIN.phone;
