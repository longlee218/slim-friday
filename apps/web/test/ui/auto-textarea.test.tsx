import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { AutoTextarea } from "../../src/components/ui/auto-textarea";

test("grows to its content so long instructions are never cut", () => {
  const spy = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(640);
  render(
    <AutoTextarea
      aria-label="Instructions"
      rows={6}
      value={"x\n".repeat(40)}
      onChange={() => {}}
    />,
  );
  expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).style.height).toBe("640px");
  spy.mockRestore();
});
