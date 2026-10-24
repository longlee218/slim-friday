import { Fragment, useEffect, useRef, useState } from "react";
import { useDirectory } from "../../api/directory";
import { Avatar } from "../ui/avatar";
import { ROUTE_SUFFIX, type RouteInfo } from "./route-info";

/** "To <faces and names>" pill under a group composer; bumps when the target changes. */
export function RouteChip({ route }: { route: RouteInfo }) {
  const dir = useDirectory();
  const key = `${route.botIds.join(",")}/${route.reason}`;
  const prev = useRef(key);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prev.current === key) return;
    prev.current = key;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 380);
    return () => clearTimeout(t);
  }, [key]);
  return (
    <div className={flash ? "route flash" : "route"}>
      {"To "}
      {route.botIds.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && ", "}
          <Avatar src={dir.bots.get(id)?.avatarUrl} name={dir.botName(id)} size={16} />
          <b>{dir.botName(id)}</b>
        </Fragment>
      ))}
      {ROUTE_SUFFIX[route.reason]}
    </div>
  );
}
