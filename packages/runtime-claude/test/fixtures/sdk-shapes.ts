/* Messages the Claude Agent SDK 0.3.295 sent in the live spike (`bun scripts/spike-sdk-shapes.ts`, model
   claude-sonnet-4-5, effort high), trimmed: text, session ids, uuids and thinking signatures are removed.
   Tool_use ids are the random ones the API issued. */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** Outcome of the spike; later tasks read it to pick how questions, thinking and subagent steps are mapped. */
export const SPIKE: {
  /** `canUseTool("AskUserQuestion")` fires and `updatedInput.answers` reaches the model as the tool_result. */
  askViaCanUseTool: boolean;
  /** How thinking shows up: an assistant content block, a `system/thinking_tokens` frame, or not at all. */
  thinking: "block" | "thinking_tokens" | "none";
  /** `system/task_started` carries the `tool_use_id` of the Agent call that started the task. */
  taskStartedHasToolUseId: boolean;
} = { askViaCanUseTool: true, thinking: "block", taskStartedHasToolUseId: true };

/** Main-thread assistant message with a Read tool_use block. */
export const ASSISTANT_TOOL_USE = {
  type: "assistant",
  parent_tool_use_id: null,
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_01CkHHg7S6RptWe9rSru9uHT",
        name: "Read",
        input: { file_path: "/tmp/spike-sdk/note.txt" },
        caller: { type: "direct" },
      },
    ],
  },
} as unknown as SDKMessage;

/** Assistant message of a subagent: `parent_tool_use_id` is the id of the Agent tool_use that started it. */
export const ASSISTANT_SUBAGENT_TOOL_USE = {
  type: "assistant",
  parent_tool_use_id: "toolu_01KUxnLY2U4AApYKChLCiV1W",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Hi" }],
  },
} as unknown as SDKMessage;

/** Successful tool_result, as the SDK sent it for the Read call (`is_error` is absent on success). */
export const USER_TOOL_RESULT_OK = {
  type: "user",
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_01CkHHg7S6RptWe9rSru9uHT",
        content: "1\thello from note.txt\n2\t",
      },
    ],
  },
} as unknown as SDKMessage;

/**
 * Failed tool_result. The spike run had no failing tool, so this is CONSTRUCTED from the observed Bash result
 * (which carried an explicit `is_error: false`) with the flag set to true, as the API's tool_result block defines.
 */
export const USER_TOOL_RESULT_ERROR = {
  type: "user",
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_01RnjkGnAj2FZa2xvvFxfhDP",
        content: "command failed",
        is_error: true,
      },
    ],
  },
} as unknown as SDKMessage;

/** Thinking block as sent with effort "high": the text is empty and only the signature is filled (stripped here). */
export const ASSISTANT_THINKING = {
  type: "assistant",
  parent_tool_use_id: null,
  message: {
    role: "assistant",
    content: [{ type: "thinking", thinking: "", signature: "<stripped>" }],
  },
} as unknown as SDKMessage;

/** `system/task_started` for a background subagent: it names the Agent tool_use that started it. */
export const TASK_STARTED = {
  type: "system",
  subtype: "task_started",
  task_id: "aff5ce4d9cfa58c02",
  tool_use_id: "toolu_01KUxnLY2U4AApYKChLCiV1W",
  description: "Say hi",
  task_type: "local_agent",
} as unknown as SDKMessage;

/** The AskUserQuestion input `canUseTool` received for a single-choice question. */
export const ASK_INPUT_SINGLE = {
  questions: [
    {
      question: "Which color do you prefer?",
      header: "Color",
      options: [
        { label: "Red", description: "Choose red as your preferred color" },
        { label: "Blue", description: "Choose blue as your preferred color" },
      ],
      multiSelect: false,
    },
  ],
};

/** The AskUserQuestion input for a multi-select question (answered `"Red, Blue"`). */
export const ASK_INPUT_MULTI = {
  questions: [
    {
      question: "Which colors do you like?",
      header: "Colors",
      options: [
        { label: "Red", description: "The color red" },
        { label: "Blue", description: "The color blue" },
      ],
      multiSelect: true,
    },
  ],
};

/** The tool_result text the model got after `updatedInput.answers` was `{ [question]: "Blue" }`. */
export const ASK_RESULT_TEXT =
  'Your questions have been answered: "Which color do you prefer?"="Blue". You can now continue with these answers in mind.';

/** Same for the multi answer `"Red, Blue"`: the labels arrive joined as the page sent them. */
export const ASK_RESULT_MULTI_TEXT =
  'Your questions have been answered: "Which colors do you like?"="Red, Blue". You can now continue with these answers in mind.';

/** Same for a free-text answer: the SDK uses a different sentence but keeps the text verbatim. */
export const ASK_RESULT_FREE_TEXT =
  'The user answered: "Which color do you prefer?"="Green please". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.';
