import type { McpServerDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { orpc } from "../../../src/api/client";
import { McpList } from "../../../src/components/settings/mcp/mcp-list";
import { seededClient } from "../../shell/fixtures";

const servers = [
  {
    name: "context7",
    type: "http",
    url: "https://mcp.context7.com/mcp",
    shipped: false,
    usedBy: [],
  },
  { name: "local", type: "stdio", command: "npx", shipped: false, usedBy: [] },
] as unknown as McpServerDto[];

test("an http server shows its site icon; a stdio server keeps the terminal tile", () => {
  const qc = seededClient({});
  qc.setQueryData(orpc.config.mcp.list.queryKey(), servers);
  qc.setQueryData(orpc.config.mcp.icon.queryKey({ input: { name: "context7" } }), {
    dataUrl: "data:image/png;base64,AAAA",
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <McpList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const row = (name: string) => screen.getByText(name).closest(".srow") as HTMLElement;
  expect(row("context7").querySelector(".ico img")?.getAttribute("src")).toBe(
    "data:image/png;base64,AAAA",
  );
  expect(row("local").querySelector(".ico img")).toBeNull();
  expect(row("local").querySelector(".ico svg")).not.toBeNull();
});
