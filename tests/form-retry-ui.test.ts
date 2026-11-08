// @vitest-environment jsdom
import { act, createElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { api, write } from "../src/client-api";
import { FormReplyCard, type Saved } from "../src/components/FormReplyCard";
import { formReplyKey } from "../src/app/storage";
import type { FormCard } from "../src/shared/reply-cards";
import { formRequestId } from "../src/shared/retry-id";
import { click, mountRoot, typeInto, waitForUi } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest({
  ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn(),
}));

const card: FormCard = {
  id: "trip", type: "form", title: "Trip details", fields: [
    { id: "city", label: "Destination", kind: "text", required: true },
    { id: "dog", label: "Bringing the dog", kind: "toggle" },
  ],
};
const key = formReplyKey("one", "shared", "message", card.id);
const answers = { city: "Marfa", dog: true };
const text = 'My answers to "Trip details":\n- Destination: Marfa\n- Bringing the dog: Yes';
const id = (attempt: number) => formRequestId("one", "shared", "message", card.id, attempt);
const show = () => {
  const mount = mountRoot();
  return { ...mount, open: () => mount.render(createElement(FormReplyCard, { card, botId: "shared", messageId: "message", userId: "one" })) };
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockReset().mockImplementation(async path => { throw new Error(`Unexpected read: ${path}`); });
  vi.mocked(write).mockReset().mockImplementation(async path => { throw new Error(`Unexpected write: ${path}`); });
});

it("reopens a still-mounted interrupted copy with the answers another copy saw accepted", async () => {
  const firstId = await id(0), retryId = await id(1);
  let interrupt!: (receipt: unknown) => void;
  vi.mocked(api).mockResolvedValueOnce({ requestId: firstId, status: "uncertain" })
    .mockImplementationOnce(async <T>() => await new Promise<T>(resolve => { interrupt = receipt => resolve(receipt as T); }));
  let accept!: (receipt: unknown) => void;
  vi.mocked(write).mockImplementationOnce(async <T>() => await new Promise<T>(resolve => { accept = receipt => resolve(receipt as T); }))
    .mockResolvedValueOnce({ requestId: retryId, status: "accepted" });
  const a = show();
  await a.open();
  await waitForUi(() => expect(a.container.querySelector("form")?.getAttribute("aria-busy")).toBe("false"));
  // B starts its lookup before A saves the request, so it has never seen A's answers.
  const b = show();
  await b.open();
  await typeInto(a.container.querySelector<HTMLInputElement>('input[type="text"]')!, "Marfa");
  await act(async () => a.container.querySelector<HTMLInputElement>('[role="switch"]')!.click());
  await click("Send answers", a.container);
  await waitForUi(() => expect(write).toHaveBeenCalledWith("/bots/shared/messages", { requestId: firstId, text, attachments: [] }));

  // B learns of the restart before A's delayed acceptance, and stays mounted throughout.
  await act(async () => interrupt({ requestId: firstId, status: "interrupted" }));
  await waitForUi(() => expect(b.container.textContent).toContain("may or may not have arrived"));
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ state: "interrupted", elsewhere: true, answers: { city: "", dog: false } });
  await act(async () => accept({ requestId: firstId, status: "accepted" }));
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ attempt: 0, state: "interrupted", answers });

  await click("They didn't arrive. Edit and send again", b.container);
  expect(b.container.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("Marfa");
  expect(b.container.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(true);
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ attempt: 1, state: "editing", answers });
  await click("Send answers", b.container);
  await waitForUi(() => expect(write).toHaveBeenCalledWith("/bots/shared/messages", { requestId: retryId, text, attachments: [] }));
});

it.each<{ reason: string; stored: Saved | null }>([
  { reason: "storage was cleared", stored: null },
  { reason: "an earlier attempt's answers are stored", stored: { attempt: 1, answers: { city: "Austin" }, state: "sent" } },
  { reason: "a later attempt is already stored", stored: { attempt: 4, answers: { city: "Austin" }, state: "sent" } },
  { reason: "the stored answers were never confirmed", stored: { attempt: 2, answers: { city: "Austin" }, state: "checking" } },
  { reason: "the stored copy does not know which answers were sent", stored: { attempt: 2, answers: { city: "Austin" }, state: "interrupted", elsewhere: true } },
])("keeps the mounted copy's answers when $reason", async ({ stored }) => {
  localStorage.setItem(key, JSON.stringify({ attempt: 2, answers, state: "interrupted" }));
  const copy = show();
  await copy.open();
  if (stored) localStorage.setItem(key, JSON.stringify(stored));
  else localStorage.removeItem(key);
  await click("They didn't arrive. Edit and send again", copy.container);
  expect(copy.container.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("Marfa");
  expect(copy.container.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(true);
  if (stored && stored.attempt > 2) expect(JSON.parse(localStorage.getItem(key)!)).toEqual(stored);
  else expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ attempt: 3, state: "editing", answers });
  expect(write).not.toHaveBeenCalled();
});
