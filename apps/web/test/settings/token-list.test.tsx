import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { TokenList } from "../../src/components/settings/token-list";

test("a typed value that is not an option is added with Enter (workspace paths)", async () => {
  const onChange = vi.fn();
  render(<TokenList values={[]} options={[]} addLabel="Grant folder" onChange={onChange} />);
  await userEvent.click(screen.getByText("Grant folder"));
  await userEvent.type(await screen.findByLabelText("Grant folder"), "/tmp/x{Enter}");
  expect(onChange).toHaveBeenCalledWith(["/tmp/x"]);
});

test("Enter adds the first matching option", async () => {
  const onChange = vi.fn();
  render(
    <TokenList
      values={["Read"]}
      options={["Read", "Grep", "Glob"]}
      addLabel="Add tool"
      onChange={onChange}
    />,
  );
  await userEvent.click(screen.getByText("Add tool"));
  await userEvent.type(await screen.findByLabelText("Add tool"), "gr{Enter}");
  expect(onChange).toHaveBeenCalledWith(["Read", "Grep"]);
});
