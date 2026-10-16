/*
 * DDL of schema v8 (lead / supervisor orchestration foundation). Additive only: new columns on `owned_tasks`
 * and `sessions`, three new tables. Plain CREATE / ALTER (no IF NOT EXISTS): an existing object of the same
 * name is a clash, not data to trust.
 */

/** New `owned_tasks` columns: a goal (parent_id null) owns items; item key is unique within its goal. */
const OWNED_TASKS_V8_DDL: readonly string[] = [
  // null = goal (root); otherwise the id of the goal this item belongs to.
  "ALTER TABLE owned_tasks ADD COLUMN parent_id TEXT",
  // Unique within the goal, e.g. "main", "design".
  "ALTER TABLE owned_tasks ADD COLUMN item_key TEXT",
  // JSON array of item keys this item waits for.
  "ALTER TABLE owned_tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE owned_tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0",
  // Circuit breaker counter: how many times the item was dispatched.
  "ALTER TABLE owned_tasks ADD COLUMN dispatch_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE owned_tasks ADD COLUMN location TEXT",
  "ALTER TABLE owned_tasks ADD COLUMN brief TEXT",
  "ALTER TABLE owned_tasks ADD COLUMN ready_at INTEGER",
  // COMPLETED | FAILED | BLOCKED | NEEDS_PLANNING | NEEDS_CLARIFICATION
  "ALTER TABLE owned_tasks ADD COLUMN result_kind TEXT",
  // Result file under <AGENT_HOME>/goals/ and its redacted excerpt (<= 600 chars).
  "ALTER TABLE owned_tasks ADD COLUMN result_path TEXT",
  "ALTER TABLE owned_tasks ADD COLUMN result_excerpt TEXT",
  "ALTER TABLE owned_tasks ADD COLUMN plan_id TEXT",
  "ALTER TABLE owned_tasks ADD COLUMN plan_version INTEGER",
  "CREATE INDEX owned_tasks_parent ON owned_tasks (parent_id)",
  // An item key is unique within its goal (goals, parent_id null, are not constrained).
  "CREATE UNIQUE INDEX owned_tasks_goal_item ON owned_tasks (parent_id, item_key) WHERE parent_id IS NOT NULL",
];

/** Versioned work plan of a goal; status draft | valid | approved | superseded | rejected. */
const WORK_PLANS_DDL = `CREATE TABLE work_plans (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  goal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  strategy TEXT NOT NULL,
  objective TEXT NOT NULL,
  body TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT '[]',
  envelope TEXT NOT NULL DEFAULT '{}',
  budget_usd REAL,
  delivery_mode TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  PRIMARY KEY (id, version)
)`;

/** Event outbox of a thread: `id` makes an append idempotent, `seq` is the FIFO order. */
const THREAD_EVENTS_DDL = `CREATE TABLE thread_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  task_id TEXT,
  item_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  created_at INTEGER NOT NULL,
  claimed_by TEXT,
  delivered_at INTEGER,
  redelivered INTEGER NOT NULL DEFAULT 0
)`;

/** Consumer lookup: the undelivered events of a thread in order. */
const THREAD_EVENTS_INDEX_DDL =
  "CREATE INDEX thread_events_pending ON thread_events (thread_id, delivered_at, seq)";

/** Audit of every side effect a grant allowed (who granted it, scope, result, undo hint). */
const EFFECT_LOG_DDL = `CREATE TABLE effect_log (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  goal_id TEXT,
  item_id TEXT,
  tool TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  result TEXT NOT NULL,
  undo TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
)`;

/** New `sessions` columns: model that owns the session, rollover generation, session kind (role | lead). */
const SESSIONS_V8_DDL: readonly string[] = [
  "ALTER TABLE sessions ADD COLUMN model TEXT",
  "ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'role'",
];

/** Every statement of the step, in order. */
export const V8_STATEMENTS: readonly string[] = [
  ...OWNED_TASKS_V8_DDL,
  WORK_PLANS_DDL,
  THREAD_EVENTS_DDL,
  THREAD_EVENTS_INDEX_DDL,
  EFFECT_LOG_DDL,
  ...SESSIONS_V8_DDL,
];
