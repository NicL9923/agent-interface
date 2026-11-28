// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, write } from "../src/client-api";
import { LearningPanel, SkillLocks } from "../src/components/automation/SkillsLearning";
import type { AutomationOverview } from "../src/shared/automation";

vi.mock("../src/client-api", async (original) =>
  (await import("./helpers/request-mock")).withRequest(
    await (async (original) => ({
      ...(await original<typeof import("../src/client-api")>()),
      api: vi.fn(),
      write: vi.fn(),
    }))(original),
  ),
);
let root: Root, container: HTMLDivElement;
const initial = (): AutomationOverview => ({
  botId: "ranch",
  owner: "Hermes",
  canManageTriggers: true,
  goals: {
    supported: true,
    goal: { title: "Prepare the fall ranch plan", status: "paused", turnsUsed: 20, maxTurns: 20 },
  },
  tasks: { supported: true, items: [] },
  triggers: { supported: true, platformEnabled: true, items: [] },
  skills: {
    supported: true,
    approvalRequired: true,
    installed: [{ name: "ranch-plan", description: "Seasonal planning" }],
    pending: [
      {
        id: "aabbccdd",
        summary: "Improve feed check",
        origin: "background",
        revision: "a".repeat(64),
      },
    ],
  },
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  vi.mocked(write).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/routines"
      ? [{ id: "routine", botId: "ranch", name: "Morning check", enabled: true }]
      : initial(),
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === name,
  )!;
async function click(name: string) {
  expect(button(name)).toBeDefined();
  await act(async () => button(name).click());
}

it("approves the displayed diff revision and refuses truncated approval", async () => {
  let truncated = true;
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes("/skills/pending/")
      ? { id: "aabbccdd", diff: "+Check water before feed.", revision: "b".repeat(64), truncated }
      : initial(),
  );
  vi.mocked(write).mockResolvedValue({ ok: true });
  await act(async () => root.render(createElement(LearningPanel, { botId: "ranch" })));
  await click("Review change");
  expect(button("Approve change").disabled).toBe(true);
  truncated = false;
  await click("Hide change");
  await click("Review change");
  await click("Approve change");
  expect(write).toHaveBeenCalledWith("/bots/ranch/automation/skills/pending/aabbccdd", {
    revision: "b".repeat(64),
    decision: "approve",
  });
});

it("retires a failed status refresh once a change and its follow-up status succeed", async () => {
  const value = initial();
  value.skills.approvalRequired = false;
  vi.mocked(api).mockResolvedValue(value);
  await act(async () => root.render(createElement(LearningPanel, { botId: "ranch" })));
  vi.mocked(api).mockRejectedValueOnce(new Error("Hermes is restarting."));
  await click("Refresh status");
  expect(container.textContent).toContain("Hermes is restarting.");
  vi.mocked(write).mockImplementation(async () => {
    value.skills.approvalRequired = true;
    return { ok: true };
  });
  await act(async () =>
    container.querySelector<HTMLInputElement>(".automation-check input")!.click(),
  );
  expect(container.textContent).toContain("Approval is required before skill changes are saved.");
  expect(container.textContent).not.toContain("Hermes is restarting.");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("keeps skill approval enabled until disabling it is explicitly confirmed", async () => {
  const value = initial();
  vi.mocked(api).mockResolvedValue(value);
  vi.mocked(write).mockImplementation(async () => {
    value.skills.approvalRequired = false;
    return { ok: true };
  });
  await act(async () => root.render(createElement(LearningPanel, { botId: "ranch" })));
  const policy = container.querySelector<HTMLInputElement>(".automation-check input")!;
  await act(async () => {
    policy.focus();
    policy.click();
  });
  expect(policy.checked).toBe(true);
  expect(write).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "WildBots can save new skills, edits and deletions without asking for approval.",
  );
  expect(document.activeElement?.textContent).toBe("Keep approval required");
  await click("Keep approval required");
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.activeElement).toBe(policy);
  expect(write).not.toHaveBeenCalled();
  await act(async () => policy.click());
  await click("Allow changes without review");
  expect(write).toHaveBeenCalledExactlyOnceWith(
    "/bots/ranch/automation/skills/policy",
    { approvalRequired: false },
    "PUT",
  );
  expect(policy.checked).toBe(false);
});

it("enables skill approval immediately without a confirmation", async () => {
  const value = initial();
  value.skills.approvalRequired = false;
  vi.mocked(api).mockResolvedValue(value);
  vi.mocked(write).mockImplementation(async () => {
    value.skills.approvalRequired = true;
    return { ok: true };
  });
  await act(async () => root.render(createElement(LearningPanel, { botId: "ranch" })));
  const policy = container.querySelector<HTMLInputElement>(".automation-check input")!;
  await act(async () => policy.click());
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(write).toHaveBeenCalledExactlyOnceWith(
    "/bots/ranch/automation/skills/policy",
    { approvalRequired: true },
    "PUT",
  );
  expect(policy.checked).toBe(true);
});

// Skill rows as the settings sheet's Behavior section lists them, each with its lock controls.
const skillRows = (names: string[]) =>
  createElement(SkillLocks, {
    botId: "ranch",
    children: (extras, messages) =>
      createElement(
        "div",
        null,
        messages,
        ...names.map((name) =>
          createElement(
            "article",
            { key: name, "data-skill": name },
            createElement("strong", null, name),
            extras({ id: name }),
          ),
        ),
      ),
  });

it("locks and unlocks an installed skill and says what the lock does", async () => {
  const value = initial();
  value.canManageLearningPolicy = true;
  value.skills.lockSupported = true;
  value.skills.installed = [
    { name: "ranch-plan", description: "Seasonal planning", locked: true },
    { name: "feed-check", description: "Feed rounds", locked: false },
  ];
  vi.mocked(api).mockResolvedValue(value);
  vi.mocked(write).mockImplementation(async (_path, body) => {
    const { name, locked } = body as { name: string; locked: boolean };
    value.skills.installed = value.skills.installed.map((item) =>
      item.name === name ? { ...item, locked } : item,
    );
    return { ok: true, name, locked };
  });
  await act(async () => root.render(skillRows(["ranch-plan", "feed-check", "not-installed"])));
  const article = (name: string) => container.querySelector(`[data-skill="${name}"]`)!;
  expect(article("ranch-plan").textContent).toContain(
    "Locked Assistants can't change this skill while it's locked.",
  );
  expect(article("feed-check").textContent).not.toContain("Locked");
  expect(article("not-installed").querySelector("button")).toBeNull();
  expect(container.textContent).not.toContain("Only an integration administrator can lock");
  const press = (name: string, skill: string) =>
    act(async () =>
      Array.from(article(skill).querySelectorAll("button"))
        .find((item) => item.textContent === name)!
        .click(),
    );
  await press("Unlock skill", "ranch-plan");
  expect(write).toHaveBeenCalledExactlyOnceWith(
    "/bots/ranch/automation/skills/lock",
    { name: "ranch-plan", locked: false },
    "PUT",
  );
  expect(container.querySelector(".form-notice")?.textContent).toBe(
    "Unlocked ranch-plan. Assistants can change it again.",
  );
  expect(article("ranch-plan").textContent).not.toContain("Assistants can't change this skill");
  await press("Lock skill", "feed-check");
  expect(write).toHaveBeenLastCalledWith(
    "/bots/ranch/automation/skills/lock",
    { name: "feed-check", locked: true },
    "PUT",
  );
  expect(article("feed-check").textContent).toContain("Locked");
});

it.each([
  ["a non-administrator", { canManageLearningPolicy: false, lockSupported: true }, true],
  ["a Hermes without skill locks", { canManageLearningPolicy: true, lockSupported: false }, false],
])("shows no lock control to %s", async (_, { canManageLearningPolicy, lockSupported }, note) => {
  const value = initial();
  value.canManageLearningPolicy = canManageLearningPolicy;
  value.skills.lockSupported = lockSupported;
  value.skills.installed = [
    {
      name: "ranch-plan",
      description: "Seasonal planning",
      ...(lockSupported ? { locked: true } : {}),
    },
  ];
  vi.mocked(api).mockResolvedValue(value);
  await act(async () => root.render(skillRows(["ranch-plan"])));
  expect(button("Lock skill")).toBeUndefined();
  expect(button("Unlock skill")).toBeUndefined();
  expect(button("Read skill")).toBeDefined();
  expect(
    container.textContent?.includes("Only an integration administrator can lock or unlock skills."),
  ).toBe(note);
  expect(
    container.textContent?.includes("Assistants can't change this skill while it's locked."),
  ).toBe(lockSupported);
});

it("hides the skill write policy in Simple presentation but keeps pending changes", async () => {
  vi.mocked(api).mockResolvedValue(initial());
  await act(async () =>
    root.render(createElement(LearningPanel, { botId: "ranch", advanced: false })),
  );
  expect(container.querySelector(".automation-learning-policy")).toBeNull();
  expect(container.textContent).toContain("Improve feed check");
});

it("collapses a reviewed skill change without fetching and reloads its revision when reopened", async () => {
  const text = "--- SKILL.md\n+++ SKILL.md\n@@ -1 +1 @@\n-old\n+<new>\n";
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes("/skills/pending/")
      ? { id: "aabbccdd", diff: text, revision: "b".repeat(64), truncated: false }
      : initial(),
  );
  await act(async () => root.render(createElement(LearningPanel, { botId: "ranch" })));
  const requests = () =>
    vi.mocked(api).mock.calls.filter(([path]) => path.includes("/skills/pending/"));
  expect(button("Review change").getAttribute("aria-expanded")).toBe("false");
  await click("Review change");
  expect(button("Hide change").getAttribute("aria-expanded")).toBe("true");
  const preview = document.getElementById(button("Hide change").getAttribute("aria-controls")!);
  expect(preview?.textContent).toBe(text);
  expect(preview?.querySelector("new")).toBeNull();
  expect(requests()).toHaveLength(1);
  await click("Hide change");
  expect(container.querySelector(".automation-diff")).toBeNull();
  expect(button("Review change").getAttribute("aria-expanded")).toBe("false");
  expect(requests()).toHaveLength(1);
  await click("Review change");
  expect(requests()).toHaveLength(2);
});

it.each(["approve", "reject"] as const)(
  "clears old policy feedback when reviewing and reports %s specifically",
  async (decision) => {
    const value = initial();
    value.skills.approvalRequired = false;
    vi.mocked(api).mockImplementation(async (path) =>
      path.includes("/skills/pending/")
        ? { id: "aabbccdd", diff: "+Check water.", revision: "b".repeat(64), truncated: false }
        : value,
    );
    vi.mocked(write).mockImplementation(async (path) => {
      if (path.endsWith("/policy")) value.skills.approvalRequired = true;
      else value.skills.pending = [];
      return { ok: true };
    });
    await act(async () => root.render(createElement(LearningPanel, { botId: "ranch" })));
    await act(async () =>
      container.querySelector<HTMLInputElement>(".automation-check input")!.click(),
    );
    expect(container.querySelector(".form-notice")?.textContent).toBe(
      "Approval is required before skill changes are saved.",
    );
    await click("Review change");
    expect(container.querySelector(".form-notice")).toBeNull();
    await click(decision === "approve" ? "Approve change" : "Reject change");
    expect(container.querySelector(".form-notice")?.textContent).toBe(
      decision === "approve" ? "Approved the skill change." : "Rejected the skill change.",
    );
    expect(container.textContent).not.toContain("Saved in Hermes.");
  },
);
