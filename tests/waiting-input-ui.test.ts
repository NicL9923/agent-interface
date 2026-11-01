// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, write } from "../src/client-api";
import { SecureRequestCard } from "../src/components/SecureRequestCard";
import { ComputerHandoffCard } from "../src/components/ComputerHandoffCard";
import { AttentionList } from "../src/app/AttentionList";
import { messageCloses, waitingPlaceholder } from "../src/app/waiting-input";
import type { AttentionRequest, Conversation } from "../src/shared/types";
import type { SecureRequest } from "../src/shared/vault";
import type { ComputerStatus } from "../src/shared/computer";
import { button, click, mountRoot, typeInto } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }))(original)));
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.mocked(api).mockReset(); vi.mocked(write).mockReset();
  ({ container, root } = mountRoot());
});
afterEach(() => vi.useRealTimers());
async function render(element: ReactElement) { await act(async () => root.render(element)); }
const login: SecureRequest = { method: "vault.save_login", epoch: "epoch", sessionId: "session", origin: "https://supply.invalid", site: "supply.invalid" };
const explicitFor = (id: string): SecureRequest => ({ ...login, explicit: { label: "Supply", purpose: "Check the order.", profile: "kitchen", requestedBy: { id, name: "Jordan" } } });
const secureRequest = (secure: SecureRequest = login, id = "srq-one"): AttentionRequest => ({ id, kind: "secure", title: "Save a login", detail: "Native request", secure });
const handoff: AttentionRequest = { id: "srq-hand", kind: "computer", title: "Take over the computer?", detail: "Needs a code",
  computer: { epoch: "epoch", sessionId: "session", reason: "The bank wants a code from your phone.", whatToDo: "Enter the code, then hand back." } };
const conversation = (attention: AttentionRequest[], state: Conversation["activity"]["state"] = "blocked"): Conversation =>
  ({ botId: "kitchen", messages: [], approvals: [], files: [], activity: { state }, attention });
const status = (control: ComputerStatus["control"], extra: Partial<ComputerStatus> = {}): ComputerStatus =>
  ({ available: true, running: true, browserReady: true, label: "Household computer", control, terminal: { available: false, target: "" }, ...extra });

describe("composer while an assistant waits", () => {
  it("tells this person a message replaces the request, unless another member's login holds it", () => {
    expect(waitingPlaceholder(conversation([secureRequest()]), "one")).toBe("Or reply here instead…");
    expect(waitingPlaceholder(conversation([handoff]), "one")).toBe("Or reply here instead…");
    expect(waitingPlaceholder(conversation([secureRequest(explicitFor("two"))]), "one")).toBe("Your message waits for Jordan…");
    expect(waitingPlaceholder(conversation([secureRequest(explicitFor("one"))]), "one")).toBe("Or reply here instead…");
    expect(waitingPlaceholder(conversation([{ id: "x", kind: "official", title: "", detail: "" }]), "one")).toBeUndefined();
    expect(waitingPlaceholder(conversation([secureRequest()], "working"), "one")).toBeUndefined();
    expect(messageCloses({ id: "q", kind: "clarify", title: "", detail: "" }, "one")).toBe(true);
  });
});

describe("secure request card", () => {
  it("shows sending, then accepted, then folds to one line that outlasts the request briefly", async () => {
    vi.useFakeTimers();
    let done!: (value: unknown) => void; vi.mocked(write).mockReturnValue(new Promise(resolve => { done = resolve; }));
    const list = (attention: AttentionRequest[]) => createElement(AttentionList, { conversation: conversation(attention), botId: "kitchen", userId: "one",
      assistantName: "Kitchen companion", disconnected: false, report: () => {} });
    await render(list([secureRequest()]));
    expect(container.textContent).toContain("Send a message instead. That cancels this request so Kitchen companion can read it and ask again.");
    const [identifier, password] = container.querySelectorAll("input");
    await typeInto(identifier, "ranch"); await typeInto(password, "secret-value");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector("form")!.getAttribute("aria-busy")).toBe("true");
    expect(button("Sending securely…").disabled).toBe(true);
    await act(async () => done({ status: "ok" }));
    expect(container.querySelector(".secure-accepted")?.textContent).toBe("Login saved. Kitchen companion is continuing.");
    await act(async () => { vi.advanceTimersByTime(1300); });
    expect(container.querySelector(".secure-request")).toBeNull();
    expect(container.querySelector(".secure-receipt")?.textContent).toBe("Login saved. Kitchen companion is continuing.");
    // Hermes stops listing it: the same line stays until its moment is over, then nothing is left.
    await render(list([]));
    expect(container.querySelectorAll(".secure-receipt")).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(container.querySelector(".secure-receipt")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("explains an answer that arrived after the request closed", async () => {
    vi.mocked(write).mockResolvedValue({ status: "expired" });
    await render(createElement(SecureRequestCard, { request: { method: "vault.code", epoch: "epoch", sessionId: "session" }, requestId: "srq-late",
      botId: "kitchen", ownerId: "one", title: "Code", detail: "Enter the code" }));
    await typeInto(container.querySelector("input")!, "123456");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.textContent).toContain("had already closed, so Hermes didn't use what you entered");
    expect(container.querySelector(".secure-receipt")).toBeNull();
  });

  it("tells another member their message waits for the requester", async () => {
    await render(createElement(SecureRequestCard, { request: explicitFor("two"), requestId: "srq-two", botId: "kitchen", ownerId: "one",
      title: "Save a login", detail: "Check first", assistantName: "Kitchen companion" }));
    expect(container.textContent).toContain("Messages you send reach Kitchen companion after they answer.");
  });
});

describe("computer handoff card", () => {
  const card = () => createElement(ComputerHandoffCard, { handoff: handoff.computer!, requestId: "srq-hand", botId: "kitchen",
    assistantName: "Kitchen companion", disconnected: false });

  it("shows the assistant's words and takes over from the transcript in one step", async () => {
    vi.mocked(api).mockResolvedValue(status({ kind: "bot", name: "kitchen" }));
    const opened = vi.fn();
    window.addEventListener("wildbots:computer", opened);
    try {
      await render(card());
      for (const text of ["Kitchen companion needs you on the computer", "The bank wants a code from your phone.", "Enter the code, then hand back.",
        "Or send a message instead."]) expect(container.textContent).toContain(text);
      await click("Take over");
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ take: true });
    } finally { window.removeEventListener("wildbots:computer", opened); }
  });

  it("says who has control and when it is this person's turn to hand back", async () => {
    vi.mocked(api).mockResolvedValue(status({ kind: "human", name: "Jordan", mine: false }));
    await render(card());
    expect(container.textContent).toContain("Jordan has control right now.");
    expect(button("Take over").disabled).toBe(true);
    vi.mocked(api).mockResolvedValue(status({ kind: "human", name: "One", mine: true }));
    await render(createElement("div")); await render(card());
    expect(container.textContent).toContain("You have control. Press Hand back");
    expect(button("Open computer").disabled).toBe(false);
    expect(Array.from(container.querySelectorAll("button")).some(item => item.textContent === "Not now")).toBe(false);
    vi.mocked(api).mockResolvedValue(status({ kind: "idle" }, { running: false, reason: "Install the household desktop packages on the Hermes host." }));
    await render(createElement("div")); await render(card());
    expect(container.textContent).toContain("Install the household desktop packages");
    expect(button("Take over").disabled).toBe(true);
  });

  it("declines with its binding and leaves one line", async () => {
    vi.mocked(api).mockResolvedValue(status({ kind: "idle" }));
    vi.mocked(write).mockResolvedValue({ status: "ok" });
    await render(card());
    await click("Not now");
    expect(write).toHaveBeenCalledWith("/bots/kitchen/computer-handoffs/srq-hand", { decision: "decline", epoch: "epoch", sessionId: "session" });
    expect(container.querySelector(".secure-receipt")?.textContent).toBe("You chose Not now. Kitchen companion will continue without it.");
  });
});
