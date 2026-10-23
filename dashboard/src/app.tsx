import { useMemo, useState } from "react";
import { SettingsContext, useApi } from "./api";
import { link, useRoute } from "./router";
import { Icon } from "./ui";
import { CostView } from "./views/cost-view";
import { GoalDetail } from "./views/goal-detail";
import { GoalsList } from "./views/goals-list";
import type { Problem } from "./views/problems-view";
import { ProblemsView } from "./views/problems-view";
import { PromptsView } from "./views/prompts-view";
import { SkillsView } from "./views/skills-view";
import { ThreadReplay, ThreadsList } from "./views/threads";

/** Time windows: label -> look-back in ms (0 = everything). */
const WINDOWS: [string, number][] = [
  ["24h", 86_400_000],
  ["7d", 7 * 86_400_000],
  ["30d", 30 * 86_400_000],
  ["All", 0],
];

/** Side nav in two groups: what happened (work), and how the agents are set up (agents). */
const NAV: { group: string; items: [string, string][] }[] = [
  { group: "Work", items: [["goals", "Goals"], ["threads", "Threads"], ["problems", "Problems"], ["cost", "Cost"]] },
  { group: "Agents", items: [["skills", "Skills"], ["prompts", "Prompts"]] },
];

/** Page titles; detail pages override with their own heading. */
const TITLES: Record<string, string> = {
  goals: "Goals",
  threads: "Threads",
  problems: "Problems",
  cost: "Cost and tokens",
  skills: "Skill use",
  prompts: "Role prompts",
};

/** Friday's mark: a plain circle-in-circle, drawn, not an emoji. */
function Mark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="9" r="3" fill="currentColor" />
    </svg>
  );
}

/** Problem count for the nav: high-severity findings only, so the badge means "look now". */
function ProblemBadge() {
  const { data } = useApi<Problem[]>("problems", true);
  const n = data?.filter((p) => p.severity === "high").length ?? 0;
  return n ? <span className="nav-count">{n}</span> : null;
}

export function App() {
  const route = useRoute();
  const [win, setWin] = useState("7d");
  const [live, setLive] = useState(true);
  const since = useMemo(() => {
    const ms = WINDOWS.find(([k]) => k === win)![1];
    return ms ? Date.now() - ms : 0;
  }, [win]);
  const meta = useApi<{ db: string; teammateCostCumulative: boolean }>("meta");
  const [section = "goals", id] = route.parts;
  const run = route.query.get("run");
  const timeless = section === "prompts";
  const detail = id && section !== "prompts";

  return (
    <SettingsContext.Provider value={{ since, live: live && !timeless }}>
      <div className="shell">
        <nav className="side" aria-label="Sections">
          <div className="brand"><Mark /> Friday ops</div>
          {NAV.map((g) => (
            <div key={g.group} className="nav-group">
              <span className="nav-group-label">{g.group}</span>
              {g.items.map(([key, label]) => (
                <a key={key} className="nav-link" href={link(key)} aria-current={section === key ? "page" : undefined}>
                  <span><Icon name={key} />{label}</span>
                  {key === "problems" && <ProblemBadge />}
                </a>
              ))}
            </div>
          ))}
          <div className="side-foot">
            <span>Read-only · {meta.data?.db?.replace(/^\/Users\/[^/]+/, "~")}</span>
          </div>
        </nav>
        <main className="main">
          <div className="topbar">
            {detail ? (
              <a className="back" href={link(section)}><Icon name="back" size={14} />{TITLES[section]}</a>
            ) : (
              <h1>{TITLES[section]}</h1>
            )}
            <span className="topbar-fill" />
            {!timeless && (
              <>
                <div className="seg" role="group" aria-label="Time window">
                  {WINDOWS.map(([k]) => (
                    <button key={k} type="button" aria-pressed={win === k} onClick={() => setWin(k)}>{k}</button>
                  ))}
                </div>
                <button type="button" className="live" aria-pressed={live} onClick={() => setLive(!live)} title="Refresh every 5 s">
                  <i />{live ? "Live" : "Paused"}
                </button>
              </>
            )}
          </div>
          <div className={`content${section === "prompts" ? " wide" : ""}`}>
            {section === "cost" && meta.data?.teammateCostCumulative && (
              <p className="note" role="note">
                <Icon name="warn" size={14} />
                Teammate cost reads high: runs before 2026-10-22 18:31 store the session total. They age out with the db retention.
              </p>
            )}
            {section === "goals" && (id ? <GoalDetail id={id} run={run} /> : <GoalsList />)}
            {section === "threads" && (id ? <ThreadReplay id={id} run={run} /> : <ThreadsList />)}
            {section === "cost" && <CostView />}
            {section === "problems" && <ProblemsView />}
            {section === "skills" && <SkillsView />}
            {section === "prompts" && (
              <PromptsView role={id ?? null} workspace={route.query.get("workspace")} channel={route.query.get("channel")} />
            )}
          </div>
        </main>
      </div>
    </SettingsContext.Provider>
  );
}
