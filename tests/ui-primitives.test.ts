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
