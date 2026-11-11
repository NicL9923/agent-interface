// @vitest-environment jsdom
import { act, createElement as h, createRef, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { Button } from "../src/components/ui/button";
import { Dialog } from "../src/components/ui/dialog";
import { FormMessage } from "../src/components/ui/form-message";
import { Input } from "../src/components/ui/input";
import { cn } from "../src/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "../src/components/ui/popover";
import { mountRoot } from "./ui-harness";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }) });
  ({ container, root } = mountRoot());
});

it("requires an explicit submit type for a shared button inside a form", async () => {
  const submit = vi.fn((event: React.SubmitEvent) => event.preventDefault());
  await act(async () => root.render(h("form", { onSubmit: submit }, h(Button, null, "Action"), h(Button, { type: "submit" }, "Save"))));
  const [action, save] = container.querySelectorAll("button");
  await act(async () => action.click());
  expect(submit).not.toHaveBeenCalled();
  await act(async () => save.click());
  expect(submit).toHaveBeenCalledTimes(1);
});

it("retains a persistent dialog's inputs while closing and reopening with custom initial focus", async () => {
  const ref = createRef<HTMLDialogElement>();
  const opener = document.createElement("button");
  document.body.append(opener); opener.focus();
  const render = async (open: boolean) => act(async () => root.render(h(Dialog, { ref, open, initialFocus: "#dialog-title" },
    h("h2", { id: "dialog-title", tabIndex: -1 }, "Settings"), h(Input, { defaultValue: "Draft" }))));
  await render(true);
  const input = container.querySelector("input")!;
  input.value = "Unsent change";
  expect(ref.current?.open).toBe(true);
  expect(document.activeElement).toBe(container.querySelector("h2"));
  await render(false);
  expect(ref.current?.open).toBe(false);
  expect(document.activeElement).toBe(opener);
  await render(true);
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("Unsent change");
});

it.each(["removed", "inert", "body"])("uses the supplied safe fallback when the original focus is %s", async (state) => {
  const opener = document.createElement("button");
  const fallback = document.createElement("button");
  document.body.append(opener, fallback);
  if (state !== "body") opener.focus();
  await act(async () => root.render(h(Dialog, { fallbackFocus: () => fallback }, h("h2", null, "Settings"))));
  if (state === "removed") opener.remove();
  if (state === "inert") opener.setAttribute("inert", "");
  await act(async () => root.unmount());
  expect(document.activeElement).toBe(fallback);
});

it("keeps focus inside when an unsaved-changes guard reopens", async () => {
  const opener = document.createElement("button");
  document.body.append(opener); opener.focus();
  await act(async () => root.render(h(Dialog, { initialFocus: "#editing", onClose: event => event.currentTarget.showModal() }, h(Input, { id: "editing" }))));
  await act(async () => container.querySelector("dialog")!.close());
  expect(container.querySelector("dialog")!.open).toBe(true);
  expect(document.activeElement).toBe(container.querySelector("input"));
});

it("does not report a stale native close event after StrictMode reopens", async () => {
  const closed = vi.fn();
  await act(async () => root.render(h(StrictMode, null, h(Dialog, { onClose: closed }, "Settings"))));
  await act(async () => container.querySelector("dialog")!.dispatchEvent(new Event("close")));
  expect(container.querySelector("dialog")!.open).toBe(true);
  expect(closed).not.toHaveBeenCalled();
});

// The top layer stacks dialogs in the order they open, and React runs a child's effect before its parent's.
it("opens a dialog nested in another after it when both mount together, and focuses the inner one last", async () => {
  const opened = () => vi.mocked(HTMLDialogElement.prototype.showModal).mock.contexts.map(dialog => (dialog as HTMLDialogElement).getAttribute("aria-label"));
  await act(async () => root.render(h(Dialog, { "aria-label": "outer", initialFocus: "#outer-field" },
    h(Input, { id: "outer-field" }),
    h(Dialog, { "aria-label": "inner", initialFocus: "#inner-field" }, h(Input, { id: "inner-field" })))));
  expect(opened()).toEqual(["outer", "inner"]);
  expect(document.activeElement?.id).toBe("inner-field");
});

it("opens a dialog nested in an outer one that is already open at once", async () => {
  await act(async () => root.render(h(Dialog, { "aria-label": "outer" })));
  await act(async () => root.render(h(Dialog, { "aria-label": "outer" }, h(Dialog, { "aria-label": "inner" }))));
  expect(vi.mocked(HTMLDialogElement.prototype.showModal).mock.contexts.map(dialog => (dialog as HTMLDialogElement).getAttribute("aria-label"))).toEqual(["outer", "inner"]);
});

it("keeps a nested dialog closed while its outer one is closed", async () => {
  // Only the outer dialog refuses to open, as a sheet whose showModal fails would.
  vi.mocked(HTMLDialogElement.prototype.showModal).mockImplementation(function (this: HTMLDialogElement) { if (this.getAttribute("aria-label") === "inner") this.open = true; });
  await act(async () => root.render(h(Dialog, { "aria-label": "outer" }, h(Dialog, { "aria-label": "inner" }))));
  expect(container.querySelector<HTMLDialogElement>('dialog[aria-label="inner"]')!.open).toBe(false);
});

it("never opens a nested dialog that unmounted while it waited for its outer one", async () => {
  const showModal = vi.mocked(HTMLDialogElement.prototype.showModal);
  showModal.mockImplementation(function (this: HTMLDialogElement) { if (this.getAttribute("aria-label") === "inner") this.open = true; });
  await act(async () => root.render(h(Dialog, { "aria-label": "outer" }, h(Dialog, { "aria-label": "inner" }))));
  await act(async () => root.render(h(Dialog, { "aria-label": "outer" })));
  // A browser throws if asked to show a dialog that is no longer in the document.
  await act(async () => { container.querySelector<HTMLDialogElement>("dialog")!.open = true; });
  expect(showModal.mock.contexts.map(dialog => (dialog as HTMLDialogElement).getAttribute("aria-label"))).toEqual(["outer"]);
});

/** Both dialogs mounted, the outer one left closed by a `showModal` that does nothing, so a test opens it by hand. */
async function mountNestedUnderClosedOuter() {
  const showModal = vi.mocked(HTMLDialogElement.prototype.showModal);
  showModal.mockImplementation(function (this: HTMLDialogElement) { if (this.getAttribute("aria-label") === "inner") this.open = true; });
  await act(async () => root.render(h(Dialog, { "aria-label": "outer" }, h(Dialog, { "aria-label": "inner" }))));
  const inner = () => showModal.mock.contexts.filter(dialog => (dialog as HTMLDialogElement).getAttribute("aria-label") === "inner").length;
  return { outer: container.querySelector<HTMLDialogElement>('dialog[aria-label="outer"]')!, inner };
}

it("stops watching its outer dialog once it has opened, so a later change to it does not open it again", async () => {
  const { outer, inner } = await mountNestedUnderClosedOuter();
  await act(async () => { outer.open = true; });
  expect(inner()).toBe(1);
  await act(async () => { outer.open = false; });
  await act(async () => { outer.open = true; });
  expect(inner()).toBe(1);
});

it("waits for its outer dialog's next opening when that opened and closed before it could open", async () => {
  const { outer, inner } = await mountNestedUnderClosedOuter();
  // One change notice for both: by the time it runs, the outer dialog is closed again.
  await act(async () => { outer.open = true; outer.open = false; });
  expect(inner()).toBe(0);
  await act(async () => { outer.open = true; });
  expect(inner()).toBe(1);
});

it.each([false, true])("portals a popover into its native dialog when nested=%s", async (nested) => {
  const popover = h(Popover, { defaultOpen: true }, h(PopoverTrigger, null, "Options"),
    h(PopoverContent, { "aria-label": "Options" }, h(Button, null, "Action")));
  await act(async () => root.render(nested ? h(Dialog, null, popover) : popover));
  const popup = document.querySelector('[data-slot="popover-content"]')!;
  expect(popup).not.toBeNull();
  expect(popup.closest("dialog")).toBe(nested ? container.querySelector("dialog") : null);
  expect(popup.parentElement?.classList.contains("tw:z-30")).toBe(true);
});

it("merges prefixed utilities while preserving existing semantic classes", () => {
  expect(cn("inline tw:z-20", "block tw:z-30")).toBe("inline block tw:z-30");
});

it("announces an error as an alert and a notice as a status, keeping layout classes", async () => {
  await act(async () => root.render(h("div", null,
    h(FormMessage, { tone: "error", className: "settings-footnote" }, "Broke"),
    h(FormMessage, { tone: "notice" }, "Done"))));
  const error = container.querySelector("p.form-error")!;
  const notice = container.querySelector("p.form-notice")!;
  expect([error.getAttribute("role"), error.className, error.textContent]).toEqual(["alert", "form-error settings-footnote", "Broke"]);
  expect([notice.getAttribute("role"), notice.textContent]).toEqual(["status", "Done"]);
});
