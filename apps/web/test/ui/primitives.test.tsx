import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { Avatar, AvatarStack } from "../../src/components/ui/avatar";
import { Badge } from "../../src/components/ui/badge";
import {
  BottomSheet,
  canStartSheetDrag,
  shouldDismissSheet,
} from "../../src/components/ui/bottom-sheet";
import { Button, IconButton } from "../../src/components/ui/button";
import { Kbd } from "../../src/components/ui/kbd";
import { Pill } from "../../src/components/ui/pill";
import { Sheet } from "../../src/components/ui/sheet";

/** True when the element carries every listed class. */
const has = (el: Element, ...cls: string[]) => cls.every((c) => el.classList.contains(c));

describe("buttons", () => {
  test("Button primary disabled has the disabled attribute and the prototype classes", () => {
    render(
      <Button variant="primary" disabled>
        Go
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Go" });
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(has(b, "btn", "primary")).toBe(true);
  });
  test("Button lg and danger map to prototype classes", () => {
    render(
      <Button variant="danger" size="lg">
        Del
      </Button>,
    );
    expect(has(screen.getByRole("button", { name: "Del" }), "btn", "danger", "lg")).toBe(true);
  });
  test("IconButton exposes its label and title", () => {
    render(<IconButton label="Send" on />);
    const b = screen.getByRole("button", { name: "Send" });
    expect(b.getAttribute("title")).toBe("Send");
    expect(has(b, "ib", "on")).toBe(true);
  });
});

describe("avatars", () => {
  test("Avatar falls back to the lead face", () => {
    render(<Avatar name="Dev" />);
    expect(screen.getByAltText("Dev").getAttribute("src")).toBe("/avatars/lead.webp");
  });
  test("Avatar working adds the arc and size", () => {
    const { container } = render(<Avatar name="Dev" working size={40} />);
    const av = container.querySelector(".av.working") as HTMLElement;
    expect(av).not.toBeNull();
    expect(av.style.width).toBe("40px");
  });
  test("AvatarStack shows max items", () => {
    const items = [{ name: "A" }, { name: "B" }, { name: "C" }];
    const { container } = render(<AvatarStack items={items} max={2} />);
    expect(container.querySelectorAll(".stack .av").length).toBe(2);
  });
});

describe("pills, badges, kbd", () => {
  test("Pill tone class", () => {
    render(<Pill tone="amber">Waiting</Pill>);
    expect(has(screen.getByText("Waiting"), "pill", "amber")).toBe(true);
  });
  test("Badge shows count, tone and bump", () => {
    render(<Badge tone="tint" count={3} bump />);
    expect(has(screen.getByText("3"), "badge", "tint", "bump")).toBe(true);
  });
  test("Kbd renders a kbd element", () => {
    render(<Kbd>K</Kbd>);
    expect(screen.getByText("K").tagName).toBe("KBD");
  });
});

describe("sheets", () => {
  test("shouldDismissSheet past 110px", () => {
    expect(shouldDismissSheet(110)).toBe(false);
    expect(shouldDismissSheet(111)).toBe(true);
  });
  test("Sheet renders children when open and calls onOpenChange on Escape", async () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange}>
        Hello sheet
      </Sheet>,
    );
    expect(screen.getByText("Hello sheet").closest(".sheet")).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });
  test("Sheet wide adds the wide class; closed renders nothing", () => {
    const { rerender } = render(
      <Sheet open wide onOpenChange={() => {}}>
        x
      </Sheet>,
    );
    expect(document.querySelector(".sheet.wide")).not.toBeNull();
    rerender(
      <Sheet open={false} onOpenChange={() => {}}>
        x
      </Sheet>,
    );
    expect(screen.queryByText("x")).toBeNull();
  });
  test("canStartSheetDrag is false inside the scrolling body", () => {
    const body = document.createElement("div");
    body.className = "bs-body";
    const input = document.createElement("input");
    body.append(input);
    const grab = document.createElement("div");
    expect(canStartSheetDrag(grab)).toBe(true);
    expect(canStartSheetDrag(input)).toBe(false);
    expect(canStartSheetDrag(null)).toBe(true);
  });
  test("BottomSheet ignores a drag that starts in the scrolling body", () => {
    const onOpenChange = vi.fn();
    render(
      <BottomSheet open onOpenChange={onOpenChange}>
        <div className="bs-body">Scroll me</div>
      </BottomSheet>,
    );
    const body = screen.getByText("Scroll me");
    fireEvent.pointerDown(body, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(body, { clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(body, { clientY: 300, pointerId: 1 });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
  test("BottomSheet focuses the first field of a form sheet, not the bar's Cancel", async () => {
    render(
      <BottomSheet open onOpenChange={() => {}}>
        <button type="button">Cancel</button>
        <div className="bs-body">
          <input aria-label="Name" />
        </div>
      </BottomSheet>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Name")));
  });
  test("BottomSheet sits on top of the iOS keyboard (visual viewport)", () => {
    const vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal("visualViewport", vv);
    window.innerHeight = 844;
    try {
      render(
        <BottomSheet open onOpenChange={() => {}}>
          Body
        </BottomSheet>,
      );
      const sheet = document.querySelector(".bsheet") as HTMLElement;
      vv.height = 500;
      vv.dispatchEvent(new Event("resize"));
      expect(sheet.style.getPropertyValue("--vv-h")).toBe("500px");
      expect(sheet.style.getPropertyValue("--kb-h")).toBe("344px");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  test("BottomSheet shows a grab handle", () => {
    render(
      <BottomSheet open onOpenChange={() => {}}>
        Body
      </BottomSheet>,
    );
    expect(document.querySelector(".bsheet .grab")).not.toBeNull();
    expect(screen.getByText("Body")).toBeTruthy();
  });
  test("BottomSheet dismisses after a drag past 110px", () => {
    const onOpenChange = vi.fn();
    render(
      <BottomSheet open onOpenChange={onOpenChange}>
        Body
      </BottomSheet>,
    );
    const sheet = document.querySelector(".bsheet") as HTMLElement;
    fireEvent.pointerDown(sheet, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(sheet, { clientY: 250, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientY: 250, pointerId: 1 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  test("BottomSheet captures the pointer only once a drag starts, so taps reach its buttons", () => {
    const capture = vi.fn();
    const proto = HTMLElement.prototype as { setPointerCapture?: (id: number) => void };
    const orig = proto.setPointerCapture;
    proto.setPointerCapture = capture;
    try {
      render(
        <BottomSheet open onOpenChange={() => {}}>
          Body
        </BottomSheet>,
      );
      const sheet = document.querySelector(".bsheet") as HTMLElement;
      fireEvent.pointerDown(sheet, { clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(sheet, { clientY: 103, pointerId: 1 });
      expect(capture).not.toHaveBeenCalled();
      fireEvent.pointerMove(sheet, { clientY: 140, pointerId: 1 });
      expect(capture).toHaveBeenCalledWith(1);
    } finally {
      proto.setPointerCapture = orig;
    }
  });
});

describe("overlays.css", () => {
  test("a .badge.bump rule applies the bump animation", () => {
    const css = readFileSync("src/styles/overlays.css", "utf8");
    const rule = css.match(/([^{}]*\.badge\.bump[^{]*)\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(/animation:[^;]*bump/.test(rule?.[2] ?? "")).toBe(true);
  });
});
