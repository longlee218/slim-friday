import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Search, SquarePen } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { useOpenPalette } from "../../app/shell-context";
import { formatCost } from "../../lib/format";
import { ChatRow, useChatRows } from "../shell/chat-rows";
import { AvatarStack } from "../ui/avatar";
import { PhoneNavBar } from "./phone-nav-bar";

/**
 * `/` on the phone: large "Chats" title, New chat (opens the palette), search by name, the live
 * row when any bot works (opens Activity) and one Messenger row per bot and group chat.
 */
export function ChatsList() {
  const navigate = useNavigate();
  const openPalette = useOpenPalette();
  const dir = useDirectory();
  const status = useQuery(orpc.control.status.queryOptions()).data ?? [];
  const approvals = useQuery(orpc.approvals.pending.queryOptions()).data ?? [];
  const [term, setTerm] = useState("");
  const scroll = useRef<HTMLDivElement>(null);

  const working = status.filter((b) => b.working);
  const rows = useChatRows().filter((r) =>
    r.name.toLowerCase().includes(term.trim().toLowerCase()),
  );

  return (
    <>
      <PhoneNavBar
        title="Chats"
        large
        scrollRef={scroll}
        right={
          <button type="button" className="nb" aria-label="New chat" onClick={openPalette}>
            <SquarePen strokeWidth={1.75} />
          </button>
        }
      />
      <div className="ios-scroll" ref={scroll}>
        <div className="large">Chats</div>
        <div className="ios-search">
          <Search strokeWidth={1.75} />
          <input
            placeholder="Search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            aria-label="Search chats"
          />
        </div>
        {working.length > 0 && (
          <button type="button" className="live" onClick={() => void navigate("/ops")}>
            <AvatarStack
              items={working.map((b) => ({
                src: dir.bots.get(b.botId)?.avatarUrl,
                name: b.name,
                working: true,
              }))}
            />
            <span className="grow">
              <b>
                {working.length} {working.length === 1 ? "bot" : "bots"} working
              </b>
              <span className="t2" style={{ display: "block" }}>
                {approvals.length > 0 && `${approvals.length} approval waiting · `}
                {formatCost(status.reduce((sum, b) => sum + b.spendToday, 0))} today
              </span>
            </span>
            <ChevronRight className="chev" strokeWidth={1.75} />
          </button>
        )}
        <div className="clist">
          {rows.map((r) => (
            <ChatRow key={r.id} row={r} size={56} onOpen={(href) => void navigate(href)} />
          ))}
        </div>
      </div>
    </>
  );
}
