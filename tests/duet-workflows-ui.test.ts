// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { api, write } from "../src/client-api";
import { TodayPanel } from "../src/components/TodayPanel";
import { OutputsPanel } from "../src/components/OutputsPanel";
import { BrainDumpDialog } from "../src/components/BrainDumpDialog";
import { ChannelCreateDialog } from "../src/components/ChannelCreateDialog";
import { BotDetails } from "../src/app/BotDetails";
import type { TodayOverview } from "../src/shared/experience";
import { defaultPreferences, type Bootstrap, type Bot } from "../src/shared/types";
import { click, mountRoot, stubImmediateFrames, typeInto } from "./ui-harness";

vi.mock("../src/client-api", async (original) =>
  (await import("./helpers/request-mock")).withRequest(
    await (async (original) => ({
      ...(await original<typeof import("../src/client-api")>()),
      api: vi.fn(),
      write: vi.fn(),
    }))(original),
  ),
);

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(write).mockReset();
  for (const [name, open] of [
    ["showModal", true],
    ["close", false],
  ] as const) {
    Object.defineProperty(HTMLDialogElement.prototype, name, {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = open;
      },
    });
  }
  stubImmediateFrames();
  ({ container, root } = mountRoot());
});

async function render(element: ReactElement) {
  await act(async () => root.render(element));
}

const mainBot: Bot = {
  id: "sage",
  name: "Sage",
  model: "claude-opus-5-5",
  shared: false,
  ownerId: "one",
  activity: "idle",
};

const bootstrap: Bootstrap = {
  user: { id: "one", name: "Nic", email: "nic@example.test" },
  household: [{ id: "one", name: "Nic", email: "nic@example.test" }],
  preferences: { ...defaultPreferences, mainBotId: "sage" },
  bots: [mainBot],
  connection: { connected: true },
  capabilities: {
    routines: { supported: true },
  } as unknown as Bootstrap["capabilities"],
  csrfToken: "csrf",
};

it("supports inline Today triage for confirmations, learning proposals, tasks, and morning briefs", async () => {
  const overview: TodayOverview = {
    generatedAt: "2026-11-26T14:00:00Z",
    frontier: "1",
    hasMore: false,
    since: "2026-11-25T14:00:00Z",
    unavailableBots: [],
    items: [],
    events: [],
    morningBrief: {
      botId: "sage",
      botName: "Sage",
      messageId: "brief-1",
      text: "Good morning! Your 9am call moved to 10am.",
      createdAt: "2026-11-26T13:30:00Z",
      cards: [],
    },
    confirmations: [
      {
        id: "conf-1",
        botId: "sage",
        botName: "Sage",
        kind: "send_email",
        title: "Send invoice reminder",
        summary: "Email accounting about #102",
        target: "billing@example.test",
        fields: [{ label: "Subject", value: "Invoice #102" }],
        status: "pending",
        decidedBy: null,
        decisionNote: null,
        createdAt: "2026-11-26T13:45:00Z",
        decidedAt: null,
      },
    ],
    tasks: [
      {
        id: "task-1",
        botId: "sage",
        botName: "Sage",
        title: "Draft vendor comparison",
        notes: "",
        status: "ready_for_review",
        summary: "Compared 3 bids; SunPeak is lowest.",
        sourceMessageId: null,
        createdBy: "bot:sage",
        createdAt: "2026-11-26T12:00:00Z",
        updatedAt: "2026-11-26T13:50:00Z",
        completedAt: null,
        completedBy: null,
      },
    ],
  };

  vi.mocked(api).mockResolvedValue(overview);
  vi.mocked(write).mockResolvedValue({ ok: true });

  await render(
    createElement(TodayPanel, {
      bootstrap,
      onOpen: vi.fn(),
      onOutputs: vi.fn(),
      onBrainDump: vi.fn(),
    }),
  );

  expect(container.textContent).toContain("Morning brief");
  expect(container.textContent).toContain("Your 9am call moved to 10am.");
  expect(container.textContent).toContain("Send invoice reminder");
  expect(container.textContent).toContain("Draft vendor comparison");
  expect(container.textContent).toContain("Ready for review");

  await click("Approve");
  expect(write).toHaveBeenCalledWith("/bots/sage/confirmations/conf-1", { decision: "approved" });

  await click("Mark done");
  expect(write).toHaveBeenCalledWith("/tasks/task-1", { status: "done" }, "PATCH");
});

it("renders cross-assistant deliverables in OutputsPanel", async () => {
  vi.mocked(api).mockResolvedValue({
    items: [
      {
        id: "card:sage:m1:c1",
        kind: "card",
        botId: "sage",
        botName: "Sage",
        messageId: "m1",
        createdAt: "2026-11-26T12:00:00Z",
        title: "Follow-up with vet",
        subtitle: "Appointment",
        card: {
          id: "c1",
          type: "email",
          title: "Follow-up with vet",
          to: ["vet@example.test"],
          subject: "Appointment",
          body: "Confirming Friday at 2pm.",
        },
      },
    ],
  });
  const onOpenMessage = vi.fn();
  await render(createElement(OutputsPanel, { bootstrap, onOpenMessage }));
  expect(container.textContent).toContain("Follow-up with vet");
  expect(container.textContent).toContain("Confirming Friday at 2pm.");
  await click("Open in chat");
  expect(onOpenMessage).toHaveBeenCalledWith("sage", "m1");
});

it("sends a structured brain dump prompt from BrainDumpDialog", async () => {
  vi.mocked(write).mockResolvedValue({ status: "accepted" });
  const onSubmitted = vi.fn();
  await render(
    createElement(BrainDumpDialog, {
      main: mainBot,
      voiceSupported: false,
      onClose: vi.fn(),
      onSubmitted,
    }),
  );
  const textarea = container.querySelector("textarea")!;
  await typeInto(textarea, "Book flights and email Sarah");
  await click("Triage with Sage");
  expect(write).toHaveBeenCalledWith(
    "/bots/sage/messages",
    expect.objectContaining({
      text: expect.stringContaining("[Brain dump triage]"),
    }),
  );
  expect(onSubmitted).toHaveBeenCalledWith("sage");
});

it("creates a topic channel from ChannelCreateDialog and toggles Morning Brief in BotDetails", async () => {
  vi.mocked(write).mockResolvedValue({
    channel: { botId: "finances", name: "#Finances" },
    bot: { id: "finances", name: "#Finances" },
  });
  const onCreated = vi.fn();
  await render(
    createElement(ChannelCreateDialog, {
      main: mainBot,
      onClose: vi.fn(),
      onCreated,
    }),
  );
  const input = container.querySelector("input")!;
  await typeInto(input, "Finances");
  await click("Create channel");
  expect(write).toHaveBeenCalledWith("/channels", { topic: "Finances" });
  expect(onCreated).toHaveBeenCalledWith("finances");

  const onMorningBrief = vi.fn().mockResolvedValue(bootstrap.preferences);
  await render(
    createElement(BotDetails, {
      boot: bootstrap,
      bot: mainBot,
      avatarState: "idle",
      conversation: null,
      connectionLost: false,
      editPreferences: vi.fn(),
      onMain: vi.fn(),
      onCheckIns: vi.fn(),
      onMorningBrief,
      onSettings: vi.fn(),
      onFind: vi.fn(),
      onClose: vi.fn(),
    }),
  );
  expect(container.textContent).toContain("Morning brief");
});
