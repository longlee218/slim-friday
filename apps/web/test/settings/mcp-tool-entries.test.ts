import { expect, test } from "vitest";
import {
  isServerEntry,
  selectedTools,
  withoutServer,
  withSelectedTools,
} from "../../src/components/settings/mcp-tool-entries";

const all = ["whoami", "k8s_list_pods", "release_apply"];

test("the whole-server entry selects every tool, per-tool entries only theirs", () => {
  expect(selectedTools(["Read", "mcp__apero"], "apero", all)).toEqual(new Set(all));
  expect(selectedTools(["mcp__apero__whoami"], "apero", all)).toEqual(new Set(["whoami"]));
  expect(selectedTools(["Read"], "apero", all)).toEqual(new Set());
});

test("a server name that starts with another is not matched", () => {
  expect(isServerEntry("mcp__apero-db__x", "apero")).toBe(false);
  expect(withoutServer(["mcp__apero", "mcp__apero__a", "mcp__apero-db"], "apero")).toEqual([
    "mcp__apero-db",
  ]);
});

test("choosing some tools writes one entry each and drops the old ones", () => {
  const next = withSelectedTools(["Read", "mcp__apero"], "apero", all, new Set(["whoami"]));
  expect(next).toEqual(["Read", "mcp__apero__whoami"]);
});

test("choosing every tool writes the whole-server entry; none removes the server", () => {
  expect(withSelectedTools(["Read", "mcp__apero__whoami"], "apero", all, new Set(all))).toEqual([
    "Read",
    "mcp__apero",
  ]);
  expect(withSelectedTools(["Read", "mcp__apero"], "apero", all, new Set())).toEqual(["Read"]);
});
