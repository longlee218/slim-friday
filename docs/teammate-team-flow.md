# Chief-of-staff Team Flow (diagrams)

> Code names still use `lead` until the rename phase (`plans/261023-1139-persistent-teammates/phase-00-rename-lead-to-teammate.md`).

Current code after the planner removal (2026-10-22). The chief-of-staff writes the plan itself; no planner role, no rolling waves. Source of truth: the code; prose in [system-architecture.md](system-architecture.md#chief-of-staff-orchestration). Plan: `plans/261022-1748-remove-planner-lead-plans/`.

## Contents
- [1. Message flow](#1-message-flow-chief-of-staff--orchestrate--workers--report--thread_events--chief-of-staff) · [2. Goal lifecycle](#2-goal-lifecycle)
- [3. Plan, revision and re-plan](#3-plan-revision-and-re-plan-same-goal) · [4. Plan artifact and /plan](#4-plan-artifact-and-plan-beside-the-revision-line)
- [5. Blocker path](#5-blocker-path-report-blocker--ask_owner--reply--auto-resume)

## 1. Message flow: chief-of-staff → Orchestrate → workers → Report → thread_events → chief-of-staff

Code decides and writes state; the chief-of-staff and the roles decide the work. The chief-of-staff is the only owner-facing voice and the only writer of plans.

```mermaid
flowchart LR
    Owner(["Owner in thread"])
    CoS["Chief-of-staff (Sonnet)<br/>answers, asks, plans, dispatches"]
    Scout["scout / researcher<br/>facts for the plan"]
    Orch["Orchestrate<br/>{ action, params }"]
    Code["Code<br/>policy, scheduler, timers,<br/>verify and fix, budget"]
    DB[("SQLite<br/>owned_tasks, work_plans,<br/>thread_events")]
    Workers["Workers: developer, scout, researcher, roster<br/>Report action tool"]

    Owner -->|message| CoS
    CoS -->|"scout dispatch (facts)"| Orch
    Scout -->|"Report result (result message)"| Code
    CoS -->|tool call| Orch
    Orch -->|"dispatch, add, update, create_plan, revise_plan, steer, retry, cancel"| Code
    Code -->|"goal, items, events"| DB
    Code -->|"start when deps done and a slot is free"| Workers
    Workers -->|"Report progress (heartbeat)"| Code
    Workers -->|"Report blocker or Report result (once)"| Code
    Code -->|"news event"| DB
    DB -->|"announce batch, 2 s window"| CoS
    CoS -->|"reply, forward, ask_owner, approve_plan"| Owner
```

## 2. Goal lifecycle

A goal is one root row. Its items are its children. A held item keeps the goal open until the chief-of-staff decides.

```mermaid
stateDiagram-v2
    [*] --> Open: dispatch (DIRECT or DELEGATE)
    [*] --> Planned: create_plan (PLAN, new goal)
    Planned --> Planned: approve_plan asked, owner No / typed answer / timeout
    Planned --> Open: owner Yes, items start
    Open --> Planned: create_plan with goalId, or revise_plan (new valid version)
    Open --> Open: items run, held items wait for the chief-of-staff
    Open --> Completed: every item completed
    Open --> Failed: an item failed (plan drops and verify superseded do not count)
    Open --> Cancelled: cancel, /stop, superseded by a new goal
    Completed --> [*]
    Failed --> [*]
    Cancelled --> [*]
```

- Item states (`pending`, `ready`, `running`, `waiting_user`, `blocked` = held, `completed`, `failed`, `cancelled`): [system-architecture.md, Goal and item model](system-architecture.md#goal-and-item-model).
- Structure owner: `lead` for DIRECT / DELEGATE, `plan` for PLAN (set at `create_plan`). Code refuses the other path's writes.
- An empty PLAN goal (no items, no valid or approved version) is cancelled by the plan-expiry sweep after `2 x PENDING_PLAN_MAX_AGE_MS`.

## 3. Plan, revision and re-plan (same goal)

The chief-of-staff brainstorms with the owner, gets code facts from a scout, writes the spec and plan as the `spec` and `plan` fields of `create_plan` (stored on the version; no artifact). Every stored version waits for the owner's answer to `approve_plan`.

```mermaid
flowchart TD
    T1["Owner says No or a typed answer (UNCLEAR)"]
    T2["PLAN_EXPIRED: no answer for PENDING_PLAN_MAX_AGE_MS (timeout event)"]
    T3["Owner asks for a change"]

    T1 & T2 & T3 --> CoS["Chief-of-staff reads the event and tells the owner"]
    CoS --> CP["Orchestrate create_plan (new goal, or goalId to re-plan)"]
    CP --> VAL{"code validates"}
    VAL -->|invalid, coded error| CoS
    VAL -->|valid| ASK["Chief-of-staff: Orchestrate approve_plan, owner asked once"]
    ASK -->|Yes| RUN["Items start in the same goal"]
    ASK -->|No, timeout, UNCLEAR| CoS
```

Revision of a stored plan (`Orchestrate revise_plan`, chief-of-staff):

```mermaid
flowchart TD
    REV["Chief-of-staff: revise_plan (compare-and-set on baseVersion)"] --> VAL{"code validates"}
    VAL -->|invalid| REV
    VAL -->|valid| NEW["New valid version (history kept)"]
    NEW --> ASK["Chief-of-staff: approve_plan, owner asked again"]
    ASK -->|Yes| APPLY["Changes apply (the approval question showed the whole plan)"]
    APPLY --> CANCEL{"Cancelled started work<br/>or changed criteria?"}
    CANCEL -->|yes| PR["plan_revised event to the chief-of-staff (diff)"]
    CANCEL -->|no| QUIET["No chief-of-staff wake-up for the revision"]
```

- A goal that still has work, or has no items after a reject or expiry, keeps its id: `create_plan` with the goal id stores the next version.
- Every revision asks the owner again; there is no auto-applied revision and no rolling waves.
- Limits (`PENDING_PLAN_MAX_AGE_MS`, `PLAN_MAX_REVISIONS`): [limits](limits-and-stop-conditions.md).

## 4. Plan artifact and /plan beside the revision line

Each plan version is a channel artifact (`Plan <goal8> v<N>`), synced on every reader. The owner sees it through the revision line button, `/plan`, or the digest. The chief-of-staff never sends a link.

```mermaid
flowchart LR
    PV["create_plan or applied revision"] --> ART["Channel artifact<br/>Plan goal8 vN (markdown)"]
    PV --> LINE["Revision line in the thread<br/>Plan vN to vN+1, +a -b ~c"]
    LINE --> BTN(["Open plan button<br/>(viewer on)"])
    BTN --> VIEW["Viewer page<br/>signed, expiring link"]
    ART -.->|"served by"| VIEW
    OWNER(["Owner"]) -->|"/plan (ephemeral, link first)"| CMD["Version in force, goal, item status"]
    OWNER -->|"/plan history"| HIST["Every version: status, date, reason"]
    CMD --> VIEW
    DIG["Check-in digest (on change, 30 min floor)<br/>Plan vN and link"] --> VIEW
    COSREPLY["Chief-of-staff reply: tells the owner to use /plan<br/>(no link in any tool result)"] -.-> OWNER
```

- The owner line `Plan vN → vN+1` is posted by code only for a re-plan after a reject (`create_plan` with the goal id); `revise_plan` posts none, the approval question carries the whole plan. The chief-of-staff still gets `plan_revised` when an approved revision cancelled work or changed criteria.
- Viewer off (`VIEWER_SECRET` / `VIEWER_BASE_URL` unset): no link anywhere; `/plan` still lists the items.
- Commands and copy: [system-architecture.md, Plan view](system-architecture.md#plan-view-plan-revision-line-plan-artifact).

## 5. Blocker path: Report blocker → ask_owner → reply → auto resume

A worker that cannot go on holds its own item. The owner's reply to the chief-of-staff's question resumes it. The chief-of-staff may instead retry or cancel.

```mermaid
sequenceDiagram
    autonumber
    participant W as Worker
    participant C as Code
    participant L as Chief-of-staff
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
    opt chief-of-staff decides instead
        L->>C: Orchestrate retry (note) or Orchestrate cancel
    end
```

- Needs values: `answer`, `access`, `decision`, `other`.
- A plain thread message (not a reply to the question) goes to the chief-of-staff, not to the worker.
