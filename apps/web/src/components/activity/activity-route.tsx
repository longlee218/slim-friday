import { useIsPhone } from "../../app/use-is-phone";
import { ActivityPage } from "./activity-page";
import { PhoneActivityTab } from "./phone-activity-tab";

/** `/ops`: the Activity page on desktop, the phone Activity tab below 640 px. */
export function ActivityRoute() {
  return useIsPhone() ? <PhoneActivityTab /> : <ActivityPage />;
}
