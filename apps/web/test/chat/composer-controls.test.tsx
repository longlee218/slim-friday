import { FILE_ACCEPT_ATTRIBUTE } from "@friday/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { CameraPicker, FilePicker } from "../../src/components/chat/composer-controls";

test("the file input accepts exactly the contract list", () => {
  render(<FilePicker inputRef={null} onFiles={() => {}} />);
  expect(screen.getByTestId("file-input").getAttribute("accept")).toBe(FILE_ACCEPT_ATTRIBUTE);
});

test("the camera input is an image input that opens the rear camera", () => {
  render(<CameraPicker inputRef={null} onFiles={() => {}} />);
  const el = screen.getByTestId("camera-input");
  expect(el.getAttribute("type")).toBe("file");
  expect(el.getAttribute("accept")).toBe("image/*");
  expect(el.getAttribute("capture")).toBe("environment");
});

test.each([
  ["file-input", FilePicker],
  ["camera-input", CameraPicker],
])("%s passes the chosen files on and resets its value", async (id, Picker) => {
  const onFiles = vi.fn();
  render(<Picker inputRef={null} onFiles={onFiles} />);
  const file = new File(["abc"], "a.png", { type: "image/png" });
  const el = screen.getByTestId(id) as HTMLInputElement;
  await userEvent.setup().upload(el, file);
  expect(onFiles).toHaveBeenCalledWith([file]);
  expect(el.value).toBe("");
});

test.each([
  ["file-input", FilePicker],
  ["camera-input", CameraPicker],
])("%s with a cancelled dialog calls onFiles with an empty list", (id, Picker) => {
  const onFiles = vi.fn();
  render(<Picker inputRef={null} onFiles={onFiles} />);
  fireEvent.change(screen.getByTestId(id), { target: { files: [] } });
  expect(onFiles).toHaveBeenCalledWith([]);
});
