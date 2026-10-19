# Lead Team Flow (diagrams)

Current code after the lead team hardening (phases 1-6a). Source of truth: the code; prose in [system-architecture.md](system-architecture.md#lead-orchestration). Plan: `plans/261018-1145-lead-team-orchestration-hardening/`.

## Contents
- [1. Message flow](#1-message-flow-lead--orchestrate--workers--report--thread_events--lead) · [2. Goal lifecycle](#2-goal-lifecycle)
- [3. Re-plan and revision](#3-re-plan-and-revision-same-goal) · [4. Plan artifact and /plan](#4-plan-artifact-and-plan-beside-the-revision-line)
- [5. Blocker path](#5-blocker-path-report-blocker--ask_owner--reply--auto-resume)

## 1. Message flow: lead → Orchestrate → workers → Report → thread_events → lead

Code decides and writes state; the lead and the roles decide the work. The lead is the only owner-facing voice.

```mermaid
flowchart LR
    Owner(["Owner in thread"])
    Lead["Lead (Sonnet)<br/>answers, asks, dispatches"]
    Orch["Orchestrate<br/>{ action, params }"]
    Code["Code<br/>policy, scheduler, timers,<br/>verify and fix, waves"]
    DB[("SQLite<br/>owned_tasks, work_plans,<br/>thread_events")]
    Planner["Planner (Sonnet)<br/>Plan action tool"]
    Workers["Workers: scout, developer, roster<br/>Report action tool"]

    Owner -->|message| Lead
    Lead -->|tool call| Orch
    Orch -->|"dispatch, add, update, request_plan, steer, retry, cancel"| Code
    Code -->|"goal, items, events"| DB
    Code -->|"start when ready"| Planner
    Code -->|"start when deps done and a slot is free"| Workers
    Planner -->|"Plan create / revise (code validates)"| Code
    Workers -->|"Report progress (heartbeat)"| Code
    Workers -->|"Report blocker or Report result (once)"| Code
    Code -->|"news event"| DB
    DB -->|"announce batch, 2 s window"| Lead
    Lead -->|"reply, forward, ask_owner, approve_plan"| Owner
```

## 2. Goal lifecycle

A goal is one root row. Its items are its children. A held item keeps the goal open until the lead decides.

```mermaid
stateDiagram-v2
    [*] --> Open: dispatch (DIRECT or DELEGATE)
    [*] --> Planning: request_plan (PLAN)
    Planning --> Planning: refused or invalid plan, planner fixes it
    Planning --> Awaiting: Plan create valid
    Awaiting --> Open: owner Yes, items start
    Awaiting --> Planning: owner No, typed answer, PLAN_EXPIRED
    Open --> Planning: request_plan with goalId (wave or re-plan)
    Open --> Open: items run, held items wait for the lead
    Open --> Completed: every item completed
    Open --> Failed: an item failed (plan drops and verify superseded do not count)
    Open --> Cancelled: cancel, /stop, superseded by a new goal
    Completed --> [*]
    Failed --> [*]
    Cancelled --> [*]
```

- Item states (`pending`, `ready`, `running`, `waiting_user`, `blocked` = held, `completed`, `failed`, `cancelled`): [system-architecture.md, Goal and item model](system-architecture.md#goal-and-item-model).
- Structure owner: `lead` for DIRECT / DELEGATE, `planner` for PLAN (set at `request_plan`). Code refuses the other side's writes.

## 3. Re-plan and revision (same goal)

Triggers reach the lead as news (a `timeout`, `failure` or `plan_revised` event) or as the owner's words. The lead re-plans with `Orchestrate request_plan` and the goal id.

```mermaid
flowchart TD
    T1["Owner says No or a typed answer (UNCLEAR)"]
    T2["PLAN_EXPIRED: no answer for 24 h (timeout event)"]
    T3["WAVE_STALLED: wave planner cancelled, plan rejected or unanswered (failure event)"]
    T4["WAVE_CAP: MAX_WAVES planners ran (failure event)"]
    T5["Owner asks for a change"]

    T1 & T2 & T3 & T4 & T5 --> Lead["Lead reads the event and tells the owner"]
    Lead --> RP["Orchestrate request_plan with goalId<br/>(structure moves to planner)"]
    RP --> PL["Planner: Plan create (after reject or expiry, next version) or Plan revise (plan still valid)"]
    PL --> VAL{"code validates"}
    VAL -->|invalid, coded error| PL
    VAL -->|valid| ASK["Lead: Orchestrate approve_plan, owner asked once"]
    ASK -->|Yes| RUN["Items start in the same goal"]
    ASK -->|No, timeout, UNCLEAR| Lead
    T4 -.->|"past MAX_WAVES: every re-plan needs the owner's Yes"| ASK
```

Revision of a valid or approved plan (`Plan revise`, planner):

```mermaid
flowchart TD
    REV["Planner: Plan revise (compare-and-set on baseVersion)"] --> Q{"Envelope grew or budget changed?"}
    Q -->|yes| OWN["Owner approves the revision first"]
    Q -->|no| APPLY["Applies at once"]
    OWN -->|Yes| APPLY
    APPLY --> LINE["Owner line: Plan vN to vN+1, +a -b ~c<br/>(none when nothing changed)"]
    APPLY --> CANCEL{"Cancelled started work<br/>or changed criteria?"}
    CANCEL -->|yes| PR["plan_revised event to the lead (diff)"]
    CANCEL -->|no| QUIET["No lead wake-up for the revision"]
```

- A goal that still has work (or is wave-held) keeps its id: `request_plan` with the goal id works.
- Re-plan past `MAX_WAVES` is allowed; each one needs the owner's approval (`MAX_WAVES` caps automatic waves only).
- Limits (`PENDING_PLAN_MAX_AGE_MS`, `MAX_WAVES`): [limits](limits-and-stop-conditions.md).

## 4. Plan artifact and /plan beside the revision line

Each plan version is a channel artifact (`Plan <goal8> v<N>`), synced on every reader. The owner sees it through the revision line button, `/plan`, or the digest. The lead never sends a link.

```mermaid
flowchart LR
    PV["Plan create or applied revision"] --> ART["Channel artifact<br/>Plan goal8 vN (markdown)"]
    PV --> LINE["Revision line in the thread<br/>Plan vN to vN+1, +a -b ~c"]
    LINE --> BTN(["Open plan button<br/>(viewer on)"])
    BTN --> VIEW["Viewer page<br/>signed, expiring link"]
    ART -.->|"served by"| VIEW
    OWNER(["Owner"]) -->|"/plan (ephemeral, link first)"| CMD["Version in force, goal, item status"]
    OWNER -->|"/plan history"| HIST["Every version: status, date, reason"]
    CMD --> VIEW
    DIG["Check-in digest (on change, 30 min floor)<br/>Plan vN and link"] --> VIEW
    LEAD["Lead reply: tells the owner to use /plan<br/>(no link in any tool result)"] -.-> OWNER
```

- The revision line is posted by code, so the lead does not repeat it. The lead still gets `plan_revised` when work was cancelled or criteria changed.
- Viewer off (`VIEWER_SECRET` / `VIEWER_BASE_URL` unset): no link anywhere; `/plan` still lists the items.
- Commands and copy: [system-architecture.md, Plan view](system-architecture.md#plan-view-plan-revision-line-plan-artifact).

## 5. Blocker path: Report blocker → ask_owner → reply → auto resume

A worker that cannot go on holds its own item. The owner's reply to the lead's question resumes it. The lead may instead retry or cancel.

```mermaid
sequenceDiagram
    autonumber
    participant W as Worker
    participant C as Code
    participant L as Lead
    actor O as Owner

    W->>C: Report blocker (reason, needs)
    C->>C: item held (blocked), run ends, dependents wait
    C->>L: blocked event (announce, 2 s window)
    L->>C: Orchestrate ask_owner (question, kind, taskId, workerAskId)
    C->>O: question message (yes/no, select or text)
    O->>C: Discord reply to that message
    C->>C: resumeWaiting: item ready, answer event (clipped to 600 chars)
    C->>W: dispatch pass resumes the session with the answer
    W->>C: Report progress, then Report result
    opt lead decides instead
        L->>C: Orchestrate retry (note) or Orchestrate cancel
    end
```

- Needs values: `answer`, `access`, `decision`, `other`. A planner has no `blocker` (it ends with a `result`).
- A plain thread message (not a reply to the question) goes to the lead, not to the worker.
