import type { SkillDto } from "@friday/contracts";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, Puzzle } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { orpc } from "../../../api/client";
import { useDirectory } from "../../../api/directory";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { Pill } from "../../ui/pill";
import { SettingsPage } from "../settings-page";
import { InstallSkillSheet } from "./install-skill-sheet";

/** One section of skills (`Installed` or `Shipped with Friday`). */
function Section({
  title,
  skills,
  updates,
}: {
  title: string;
  skills: SkillDto[];
  updates: Set<string>;
}) {
  const dir = useDirectory();
  return (
    <>
      <h3 className="grp-h">{title}</h3>
      <div className="list-panel">
        {skills.map((s) => (
          <Link key={s.name} className="srow" to={`/settings/skills/${s.name}`}>
            <span className="ico purple">
              <Puzzle size={16} strokeWidth={1.75} />
            </span>
            <div className="grow">
              <b className="mono" style={{ fontWeight: 600 }}>
                {s.name}
              </b>
              <div className="t2">{s.description}</div>
              {s.source && <div className="t2">{s.source}</div>}
            </div>
            <span className="stack">
              {s.usedBy.map((id) => (
                <Avatar
                  key={id}
                  src={dir.bots.get(id)?.avatarUrl}
                  name={dir.botName(id)}
                  size={20}
                />
              ))}
            </span>
            {updates.has(s.name) && <Pill tone="blue">update</Pill>}
            <ChevronRight size={16} className="chev" />
          </Link>
        ))}
      </div>
    </>
  );
}

/** `/settings/skills`: installed and shipped skills, with "Install skill". */
export function SkillList() {
  const navigate = useNavigate();
  const [installing, setInstalling] = useState(false);
  const skills = useQuery(orpc.config.skills.list.queryOptions()).data ?? [];
  // Subscribes to the cached "check for updates" answers; it never starts a check itself.
  const checks = useQueries({
    queries: skills.map((s) => ({
      ...orpc.config.skills.checkUpdate.queryOptions({ input: { name: s.name } }),
      enabled: false,
    })),
  });
  const updates = new Set(
    skills.filter((_, i) => checks[i]?.data?.updateAvailable).map((s) => s.name),
  );
  return (
    <SettingsPage
      title="Skills & plugins"
      // The phone hides the page head, so "Install skill" lives in the nav bar there.
      right={
        <button
          type="button"
          className="nb"
          aria-label="Install skill"
          onClick={() => setInstalling(true)}
        >
          <Plus strokeWidth={1.75} />
        </button>
      }
    >
      <div className="page-head">
        <div className="grow">
          <h2>Skills & plugins</h2>
          <div className="r">
            Know-how a bot loads on demand. Give a skill to a bot in its Tools & skills tab.
          </div>
        </div>
        <Button variant="primary" onClick={() => setInstalling(true)}>
          <Plus size={14} strokeWidth={1.75} />
          Install skill
        </Button>
      </div>
      <Section title="Installed" skills={skills.filter((s) => !s.shipped)} updates={updates} />
      <Section
        title="Shipped with Friday"
        skills={skills.filter((s) => s.shipped)}
        updates={updates}
      />
      <InstallSkillSheet
        open={installing}
        onOpenChange={setInstalling}
        onInstalled={(name) => void navigate(`/settings/skills/${name}`)}
      />
    </SettingsPage>
  );
}
