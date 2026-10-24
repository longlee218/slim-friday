import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { galleryClass, ImageGallery } from "../../src/components/chat/image-gallery";
import { ImageViewer } from "../../src/components/chat/image-viewer";
import { chatClient, image, msg, NOW, view } from "./fixtures";

const files = [image("a", { width: 800, height: 400 }), image("b"), image("c")];

test("gallery class by count", () => {
  expect([1, 2, 3, 4, 6].map(galleryClass)).toEqual(["n1", "n2", "n3", "n4", "n4"]);
});

test("a single image keeps its own ratio", () => {
  const { container } = view(
    <ImageGallery files={[files[0] as never]} message={msg()} />,
    chatClient(["a"]),
  );
  expect(container.querySelector(".gallery.n1")).toBeTruthy();
  expect((container.querySelector(".shot img") as HTMLElement).style.aspectRatio).toBe("800 / 400");
});

test("viewer steps with arrow keys and closes on Escape", async () => {
  const onClose = vi.fn();
  view(
    <ImageViewer files={files} index={0} botName="Dev" at={NOW} onClose={onClose} />,
    chatClient(["a", "b", "c"]),
  );
  expect(screen.getByText("1 / 3")).toBeTruthy();
  await userEvent.keyboard("{ArrowRight}");
  expect(screen.getByText("2 / 3")).toBeTruthy();
  expect(screen.getByText(/Dev/, { selector: ".grow span" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

test("viewer shows a failed state", async () => {
  view(
    <ImageViewer files={files} index={0} botName="Dev" at={NOW} onClose={() => {}} />,
    chatClient(["a", "b", "c"]),
  );
  const img = await screen.findByAltText("a.png");
  img.dispatchEvent(new Event("error"));
  expect(await screen.findByText("Could not load this image.")).toBeTruthy();
});

test("opening a thumbnail shows the viewer and focus returns on close", async () => {
  view(<ImageGallery files={files} message={msg()} />, chatClient(["a", "b", "c"]));
  const shot = screen.getByRole("button", { name: "Open b.png" });
  await userEvent.click(shot);
  expect(screen.getByRole("dialog")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(shot);
});
