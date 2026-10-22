import { useState } from "react";
import { useApi } from "../api";
import { ago } from "../format";
import { Load, Role, roleColor, Section, Share, Tabs } from "../ui";

interface SkillCall {
  skill: string;
  role: string;
  calls: number;
  runs: number;
  last_at: number;
}
interface RoleOffer {
  role: string;
  runs: number;
  offered: Record<string, { offered: number; called: number }>;
}
interface SkillsData {
  calls: SkillCall[];
  offers: RoleOffer[];
}

/** "friday:plan-work" -> ["friday:", "plan-work"]: the namespace reads as a quiet prefix. */
function SkillName({ name }: { name: string }) {
  const i = name.indexOf(":");
  return (
    <>
      <span className="mono">{i > 0 ? name.slice(i + 1) : name}</span>
      {i > 0 && <div className="sub">{name.slice(0, i)}</div>}
    </>
  );
}

/** Same skill under its short and long names ("plan-work", "friday:plan-work") is one skill. */
const short = (s: string) => s.slice(s.indexOf(":") + 1);

/**
 * Skill use: which skills runs actually call (and by which roles), then per role which offered skills get called
 * and which never do — the signal for pruning a role's skill list or fixing a skill's description.
 */
export function SkillsView() {
  const state = useApi<SkillsData>("skills", true);
  const [role, setRole] = useState<string | null>(null);
  return (
    <Load state={state} isEmpty={(d) => !d.calls.length && !d.offers.length} empty="No skill use in this window.">
      {({ calls, offers }) => {
        const bySkill = new Map<string, SkillCall[]>();
        for (const c of calls) bySkill.set(c.skill, [...(bySkill.get(c.skill) ?? []), c]);
        const skills = [...bySkill.entries()]
          .map(([skill, rows]) => ({
            skill,
            rows: rows.sort((a, b) => b.calls - a.calls),
            calls: rows.reduce((s, r) => s + r.calls, 0),
            last: Math.max(...rows.map((r) => r.last_at)),
          }))
          .sort((a, b) => b.calls - a.calls);
        const maxCalls = Math.max(1, ...skills.map((s) => s.calls));
        const current = offers.find((o) => o.role === (role ?? offers[0]?.role));
        const offered = current
          ? Object.entries(current.offered)
              .map(([skill, o]) => ({ skill, ...o }))
              .sort((a, b) => b.called / b.offered - a.called / a.offered || a.skill.localeCompare(b.skill))
          : [];
        const never = offered.filter((o) => !o.called).length;
        return (
          <>
            <Section title="Skills called" note={`${skills.length} skills · ${calls.reduce((s, c) => s + c.calls, 0)} calls`}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Skill</th>
                      <th>Calls</th>
                      <th>Called by</th>
                      <th className="r">Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skills.map((s) => (
                      <tr key={s.skill}>
                        <td className="skill-cell"><SkillName name={s.skill} /></td>
                        <td style={{ width: "28%" }}><Share value={s.calls / maxCalls} label={String(s.calls)} /></td>
                        <td>
                          <span className="role-counts">
                            {s.rows.map((r) => (
                              <span key={r.role}><Role role={r.role} /> <span className="faint num">{r.calls}</span></span>
                            ))}
                          </span>
                        </td>
                        <td className="r muted">{ago(s.last)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            {current && (
              <Section
                title="Offered and called, per role"
                note={`${current.runs} runs of ${current.role} logged · ${never} of ${offered.length} offered skills never called`}
              >
                <Tabs tabs={offers.map((o) => [o.role, o.role])} value={current.role} onChange={setRole} />
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Skill</th>
                        <th>Called in runs</th>
                        <th className="r">Runs called / offered</th>
                      </tr>
                    </thead>
                    <tbody>
                      {offered.map((o) => (
                        <tr key={o.skill} className={o.called ? undefined : "dim"}>
                          <td>
                            <SkillName name={o.skill} />
                            {!o.called && <span className="tag">never called</span>}
                            {calls.some((c) => short(c.skill) === short(o.skill) && c.role !== current.role) && !o.called && (
                              <span className="sub">called by other roles</span>
                            )}
                          </td>
                          <td style={{ width: "34%" }}>
                            <Share value={o.called / o.offered} label={`${Math.round((o.called / o.offered) * 100)}%`} color={roleColor(current.role)} />
                          </td>
                          <td className="r muted">{o.called} / {o.offered}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            )}
          </>
        );
      }}
    </Load>
  );
}
