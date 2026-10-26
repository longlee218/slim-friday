import type { ConversationDto } from "@friday/contracts";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { Composer } from "../../src/components/chat/composer";
import { conv, seededClient } from "../shell/fixtures";
import { view } from "./fixtures";

const mocks = vi.hoisted(() => ({
  uploadCreate: vi.fn(),
  toast: Object.assign(vi.fn(), { custom: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { chat: { send: vi.fn(), uploadCreate: mocks.uploadCreate } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  mocks.uploadCreate.mockResolvedValue({ uploadId: "u1", putUrl: "https://r2/p" });
});

const devConv: ConversationDto = { ...conv("bot:dev", 0), botId: "dev", title: "Dev" };

function composer(phone: boolean) {
  view(
    <Composer
      conversation={devConv}
      phone={phone}
      reply={null}
      onClearReply={() => {}}
      draft=""
      onDraft={() => {}}
    />,
    seededClient({}),
  );
}

const camera = () => screen.getByTestId("camera-input");

test("the phone composer has a Camera button that opens the camera input", async () => {
  composer(true);
  const click = vi.spyOn(camera(), "click");
  await userEvent.setup().click(screen.getByRole("button", { name: "Take a photo" }));
  expect(click).toHaveBeenCalledTimes(1);
});

test("the desktop composer has no Camera button or camera input", () => {
  composer(false);
  expect(screen.queryByRole("button", { name: "Take a photo" })).toBeNull();
  expect(screen.queryByTestId("camera-input")).toBeNull();
  expect(screen.getByRole("button", { name: /Attach files/ })).toBeTruthy();
});

test("a photo from the camera becomes a chip", async () => {
  composer(true);
  const photo = new File(["abc"], "image.jpg", { type: "image/jpeg" });
  await userEvent.setup().upload(camera(), photo);
  expect(await screen.findByText("image.jpg")).toBeTruthy();
});

test("a cancelled camera or file dialog adds no chip and no toast", () => {
  composer(true);
  for (const id of ["camera-input", "file-input"]) {
    fireEvent.change(screen.getByTestId(id), { target: { files: [] } });
  }
  expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  expect(mocks.toast).not.toHaveBeenCalled();
  expect(mocks.uploadCreate).not.toHaveBeenCalled();
});

test("a HEIC photo is refused with the usual unsupported-type message", async () => {
  composer(true);
  const photo = new File(["abc"], "IMG_1234.HEIC", { type: "image/heic" });
  await userEvent.setup().upload(camera(), photo);
  expect(mocks.toast).toHaveBeenCalledWith("IMG_1234.HEIC is not a supported file type.");
  expect(screen.queryByText("IMG_1234.HEIC")).toBeNull();
  expect(mocks.uploadCreate).not.toHaveBeenCalled();
});
