// Domain types for the chat screen. Shapes follow the agent's concepts
// (role templates, groups with a router, per-request caps, owner decisions)
// so the fixture store can later be swapped for the local API.

/** Role template keys; a template fixes tools and approvals. */
export type RoleKey =
  | "lead"
  | "developer"
  | "tester"
  | "researcher"
  | "designer"
  | "writer"
  | "devops"
  | "security";

/** One AI teammate the owner created from a template. */
export interface Teammate {
  id: string;
  name: string;
  role: RoleKey;
  /** File name in /avatars without extension. */
  avatar: string;
  model: string;
  /** Owner's own instructions, added on top of the role template. */
  instructions: string;
  /** The teammate's durable notes (markdown); read-only for the owner. */
  memory: string;
  memoryUpdatedAt?: number;
  /** Current task, shown in the inspector. */
  now?: { title: string; pct: number };
}

/** Form input for a new teammate. */
export interface NewTeammateInput {
  name: string;
  role: RoleKey;
  model: string;
  instructions: string;
}

/** Form input for a new group. */
export interface NewGroupInput {
  name: string;
  /** What the group is for; every member reads it before answering. */
  description: string;
  members: string[];
  router: string;
  maxTurns: number;
  maxCost: number;
}

/** Owner decision states shared by approval and question cards. */
export type DecisionState = "pending" | "expired" | string;

/** Image or file attached to a message. `url` is an object URL for local uploads. */
export interface Attachment {
  id: string;
  type: "image" | "file";
  name: string;
  /** Bytes. */
  size: number;
  url?: string;
  /** True until the upload finishes. */
  uploading?: boolean;
}

/** One choice of a select question; `hint` is a short consequence line. */
export interface ChoiceOption {
  label: string;
  hint?: string;
}

/**
 * Question kinds follow the agent's ask_owner: yes/no, pick one option, or free text.
 * Approval is a yes/no about a risky effect and keeps its own message kind.
 */
export type AskKind = "yesno" | "select" | "text";

/** Every item that can appear in a conversation feed. `replyTo` = id of the quoted message. */
export type Message =
  | { id: string; kind: "stamp"; text: string }
  | { id: string; kind: "system"; text: string }
  | { id: string; kind: "route"; from: string; to: string }
  | {
      id: string;
      kind: "text";
      from: string;
      text: string;
      attachments?: Attachment[];
      replyTo?: string;
      handoffTo?: string;
      failed?: boolean;
    }
  | { id: string; kind: "file"; from: string; name: string; size: number; replyTo?: string }
  | { id: string; kind: "task"; from: string; title: string; note: string; pct: number }
  | { id: string; kind: "approval"; from: string; title: string; detail: string; state: DecisionState }
  | {
      id: string;
      kind: "question";
      from: string;
      ask: AskKind;
      text: string;
      /** Extra context under the question. */
      detail?: string;
      /** Used by `select` only. */
      options?: ChoiceOption[];
      state: DecisionState;
    };

/** Per-request limits of a group run. */
export interface GroupCaps {
  turns: number;
  maxTurns: number;
  cost: number;
  maxCost: number;
}

interface ChatBase {
  id: string;
  /** Last activity, epoch ms; the list sorts by it. */
  updatedAt: number;
  unread: boolean;
  messages: Message[];
}
export interface DirectChat extends ChatBase {
  kind: "direct";
  with: string;
}
export interface GroupChat extends ChatBase {
  kind: "group";
  name: string;
  /** Purpose and definition of done, written by the owner; every member reads it before answering. */
  description: string;
  members: string[];
  /** Teammate that picks the next speaker. */
  router: string;
  caps: GroupCaps;
  /** Group run state: idle, running, paused at a limit, stopped by the owner. */
  run: "idle" | "running" | "paused" | "stopped";
  /** Shared group memory (markdown) every member reads; the owner can edit it. */
  memory: string;
  memoryUpdatedAt?: number;
}
export type Chat = DirectChat | GroupChat;

/** Transport health shown in the toolbar. */
export type Connection = "online" | "connecting" | "offline";

/** Extra parts of an owner message besides its text. */
export interface SendExtras {
  replyTo?: string;
  attachments?: Attachment[];
}

/** True when a message is a decision still waiting for the owner. */
export function isPendingDecision(m: Message): boolean {
  return (m.kind === "approval" || m.kind === "question") && m.state === "pending";
}
