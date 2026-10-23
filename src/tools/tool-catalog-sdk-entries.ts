import { CAPABILITY_TOOLS } from "./capability-tools";
import { TASK_STOP_TOOL_NAME } from "./sdk-tool-names";
import type { ToolDecl } from "./tool-decl";

const ALL = ["worker", "teammate"] as const;

/**
 * The SDK built-in tool groups as assignable tool ids (the role `capabilities`). `ask` is worker only:
 * a teammate asks the owner through `Orchestrate ask_owner`.
 */
export const SDK_TOOL_ENTRIES: readonly ToolDecl[] = [
  {
    id: "read",
    sdkTools: CAPABILITY_TOOLS.read,
    readOnly: true,
    risk: "R0",
    needs: ["location.read"],
    runKinds: ALL,
    subagentUsable: true,
  },
  {
    id: "write",
    sdkTools: CAPABILITY_TOOLS.write,
    readOnly: false,
    risk: "R1",
    needs: ["location.write"],
    runKinds: ALL,
    subagentUsable: true,
  },
  {
    id: "shell",
    sdkTools: CAPABILITY_TOOLS.shell,
    readOnly: false,
    risk: "R1",
    needs: ["shell"],
    runKinds: ALL,
    subagentUsable: true,
  },
  {
    id: "web",
    sdkTools: CAPABILITY_TOOLS.web,
    readOnly: true,
    risk: "R0",
    needs: [],
    runKinds: ALL,
    autoAllow: true,
    subagentUsable: true,
  },
  {
    id: "skills",
    sdkTools: CAPABILITY_TOOLS.skills,
    readOnly: true,
    risk: "R0",
    needs: [],
    runKinds: ALL,
    autoAllow: true,
    subagentUsable: true,
  },
  {
    id: "subagents",
    sdkTools: CAPABILITY_TOOLS.subagents,
    readOnly: false,
    risk: "R1",
    needs: [],
    runKinds: ALL,
    autoAllow: true,
  },
  {
    id: "tasks",
    sdkTools: CAPABILITY_TOOLS.tasks,
    readOnly: true,
    risk: "R0",
    needs: [],
    runKinds: ALL,
    autoAllow: true,
    askTools: [TASK_STOP_TOOL_NAME],
  },
  {
    id: "mcp",
    sdkTools: CAPABILITY_TOOLS.mcp,
    readOnly: true,
    risk: "R0",
    needs: [],
    runKinds: ALL,
    autoAllow: true,
  },
  {
    id: "review",
    sdkTools: CAPABILITY_TOOLS.review,
    readOnly: true,
    risk: "R0",
    needs: [],
    runKinds: ALL,
  },
  {
    id: "feedback",
    sdkTools: CAPABILITY_TOOLS.feedback,
    readOnly: false,
    risk: "R1",
    needs: [],
    runKinds: ALL,
  },
  {
    id: "ask",
    sdkTools: CAPABILITY_TOOLS.ask,
    readOnly: true,
    risk: "R0",
    needs: [],
    runKinds: ["worker"],
  },
];
