import type { Chat, Teammate } from "./chat-types";

// Illustrative data until the local agent API exists. Not real runs.

const MIN = 60_000;
const now = Date.now();

export const FIXTURE_TEAM: Teammate[] = [
  {
    id: "friday",
    name: "Friday",
    role: "lead",
    avatar: "lead",
    model: "Sonnet 5.5",
    instructions: "Keep me out of small decisions. Ask once, with options.",
    memory: `# Owner
- Writes Vietnamese, prefers short answers in simple English.
- Budget per goal: under $5 unless asked.

# Working style
- Plan first for anything over one file.
- Never push without approval.`,
    memoryUpdatedAt: now - 50 * MIN,
  },
  {
    id: "kai",
    name: "Kai",
    role: "developer",
    avatar: "developer",
    model: "Sonnet 5.5",
    instructions: "Bun and TypeScript. Write the failing test first.",
    memory: `# friday-slim-agent
- Tests: \`bun test\`; 5 flaky cases under load are known.
- SQL lives only in src/storage.

# Lessons
- Flush must not block /stop.`,
    memoryUpdatedAt: now - 41 * MIN,
    now: { title: "Memory flush", pct: 62 },
  },
  {
    id: "quinn",
    name: "Quinn",
    role: "tester",
    avatar: "tester",
    model: "Sonnet 5.5",
    instructions: "",
    memory: "- Regression suite: 1,900 pass, 5 flaky.",
    memoryUpdatedAt: now - 2 * 24 * 60 * MIN,
  },
  {
    id: "ivy",
    name: "Ivy",
    role: "researcher",
    avatar: "researcher",
    model: "Sonnet 5.5",
    instructions: "Two sources minimum for every claim.",
    memory: "",
  },
  { id: "mira", name: "Mira", role: "designer", avatar: "designer", model: "Opus 5.5", instructions: "", memory: "" },
];

export const FIXTURE_CHATS: Chat[] = [
  {
    id: "g-memory",
    kind: "group",
    name: "Memory v2",
    description:
      "Ship memory v2: one channel MEMORY.md, flush after compaction, dreaming at night. Done = tests green and verify passed, under $5.",
    members: ["friday", "ivy", "kai", "quinn"],
    router: "friday",
    caps: { turns: 7, maxTurns: 16, cost: 1.42, maxCost: 5 },
    run: "idle",
    memory: `# Goal
Ship memory v2 under $5.

# Decisions
- One channel MEMORY.md; flush after compaction.
- Kai owns the code, Quinn verifies.

# Open
- Flush race on /stop.`,
    memoryUpdatedAt: now - 20 * MIN,
    updatedAt: now - 3 * MIN,
    unread: false,
    messages: [
      { id: "m1", kind: "stamp", text: "Today 9:12" },
      { id: "m2", kind: "text", from: "me", text: "Ship memory v2. Keep it under $5." },
      { id: "m3", kind: "route", from: "friday", to: "ivy" },
      {
        id: "m4",
        kind: "text",
        from: "ivy",
        text: "One channel MEMORY.md plus a flush after compaction is enough. Sources are in the plan.",
        handoffTo: "kai",
      },
      { id: "m5", kind: "task", from: "kai", title: "Memory flush", note: "Tests green", pct: 62 },
      {
        id: "m6",
        kind: "approval",
        from: "kai",
        title: "Push 3 commits?",
        detail: "feat/memory-v2",
        state: "pending",
      },
      {
        id: "m7",
        kind: "question",
        from: "quinn",
        ask: "select",
        text: "Verify failed on a flush race. How should I fix it?",
        options: [
          { label: "2s debounce", hint: "Smallest change, one more verify run" },
          { label: "Lock the journal", hint: "Safer, touches 3 files" },
          { label: "Skip for now", hint: "Ship without the flush" },
        ],
        state: "pending",
      },
    ],
  },
  {
    id: "d-friday",
    kind: "direct",
    with: "friday",
    updatedAt: now - 6 * MIN,
    unread: false,
    messages: [
      { id: "f1", kind: "stamp", text: "Today 9:38" },
      { id: "f2", kind: "text", from: "me", text: "How is memory v2 going?" },
      {
        id: "f3",
        kind: "text",
        from: "friday",
        text: "Kai is at 62%. Two decisions are waiting for you in Memory v2.",
        replyTo: "f2",
      },
      { id: "f4", kind: "file", from: "friday", name: "Memory v2 plan.md", size: 4180 },
      {
        id: "f5",
        kind: "question",
        from: "friday",
        ask: "yesno",
        text: "Run the dreaming job tonight at 02:00?",
        detail: "About $0.40, Haiku only",
        state: "pending",
      },
    ],
  },
  {
    id: "d-kai",
    kind: "direct",
    with: "kai",
    updatedAt: now - 41 * MIN,
    unread: false,
    messages: [
      { id: "k1", kind: "stamp", text: "Today 9:05" },
      {
        id: "k2",
        kind: "question",
        from: "kai",
        ask: "text",
        text: "Should the flush also run on /stop? Tell me the rule you want.",
        state: "pending",
      },
    ],
  },
  {
    id: "d-quinn",
    kind: "direct",
    with: "quinn",
    updatedAt: now - 2 * 24 * 60 * MIN,
    unread: true,
    messages: [
      { id: "q1", kind: "stamp", text: "Monday" },
      { id: "q2", kind: "text", from: "quinn", text: "Regression suite: 1,900 pass, 5 flaky." },
      {
        id: "q3",
        kind: "approval",
        from: "quinn",
        title: "Delete 5 flaky test snapshots?",
        detail: "test/__snapshots__",
        state: "expired",
      },
    ],
  },
  { id: "d-ivy", kind: "direct", with: "ivy", updatedAt: now - 3 * 24 * 60 * MIN, unread: false, messages: [] },
  { id: "d-mira", kind: "direct", with: "mira", updatedAt: now - 4 * 24 * 60 * MIN, unread: false, messages: [] },
];
