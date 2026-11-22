import type { CDPSession, Page, Route } from "@playwright/test";
import { assistants, expect, signIn, test } from "./fixtures.js";
import { SCREENS, type Screen } from "./screens.js";
import { STATEFUL, type StatefulScreen } from "./cascade-screens.js";
import { groupFixture, openGroup } from "./group-fixture.js";

// The app's own stylesheets sit in the base, components and motion cascade layers, and the layers rank by name
// before specificity. The rules were written to meet by specificity and position, as they did before #457 added the
// layers, so a base rule that used to win by being more specific now loses to any component rule, and a component
// rule loses to the motion layer the same way. Each screen below is read with the layers as built and with those
// three layers' blocks unwrapped in place, which is how the same rules met before layers, and no computed value may
// move. Chromium also reads every control hovered, focused from the keyboard and pressed, since most of these
// rules are states: the base button hover beat any one-class background on a button before layers, and does not now.
//
// The screens in e2e/cascade-screens.ts are read in several states each, every state reached from the one before it in
// the same page.
//
// When a value moves, find the two rules that set it (the failure names the element, property and both values) and put
// the losing one in the winner's layer, beside it, so specificity decides again. Never fix it with !important.

const LAYERED = ["base", "components", "motion"];

// The routes below give screens their content. With the service worker registered they do not take effect in
// Playwright's WebKit; blocking it restores page routing, as in bot-exchanges.spec.ts.
test.use({ serviceWorkers: "block" });

/** The server's answer in full: a read the client already holds would come back as an empty 304. */
const fresh = (route: Route) => {
  const headers = { ...route.request().headers() };
  delete headers["if-none-match"];
  return route.fetch({ headers });
};

/**
 * Gives the Ranch Hand's chat a reply with the Markdown the bubbles and tables style, an approval and a question, and
 * the assistant the instructions its settings need. Installed before sign-in: the server remembers the chat last
 * open, and the page reads it before any screen is reached.
 */
async function fixtures(page: Page) {
  await page.route(/\/api\/bots\/ranch\/conversation/, async (route) => {
    const body = await (await fresh(route)).json();
    // Earlier turns, so the chat scrolls and the message rail shows beside it at wide widths.
    const earlier = Array.from({ length: 8 }, (_, turn) => [
      { id: `lx-q${turn}`, role: "user", text: `Is the east tank full, check ${turn + 1}?` },
      {
        id: `lx-r${turn}`,
        role: "assistant",
        text: `Check ${turn + 1}: the tank is full and the float valve works.`,
      },
    ]).flat();
    body.messages = [
      ...earlier,
      {
        id: "lx-u1",
        role: "user",
        text: "What needs fixing on the north fence?",
        createdAt: "2026-11-05T13:00:00Z",
      },
      {
        id: "lx-a1",
        role: "assistant",
        createdAt: "2026-11-05T13:01:00Z",
        text: [
          "## Fence report",
          "",
          "Post **two** leans after the storm, and `the gate` sticks.",
          "",
          "- Tighten the wire",
          "- Oil the latch",
          "",
          "> Check the south line next week.",
          "",
          "| Post | State | Note | Wire | Last checked | Who checked it |",
          "| --- | --- | --- | --- | --- | --- |",
          "| 2 | Loose | Leaned a few degrees east after the storm | Slack | November 5 | Ranch Hand |",
          "",
          "```sh",
          "fence check --line north",
          "```",
        ].join("\n"),
      },
      ...body.messages,
    ];
    body.approvals = [
      {
        id: "lx-approval",
        title: "Run a command",
        detail: "systemctl restart gate",
        status: "pending",
      },
    ];
    body.attention = [
      {
        id: "lx-question",
        kind: "clarify",
        title: "Which gate?",
        detail: "",
        questions: [
          {
            id: "gate",
            prompt: "Which gate first?",
            options: ["North", "South (Recommended)"],
            recommended: 1,
          },
        ],
      },
    ];
    await route.fulfill({ json: body });
  });
  // The e2e runtime's assistant has no instructions, which the settings read requires.
  await page.route(/\/api\/bots\/ranch$/, async (route) => {
    const body = await (await fresh(route)).json();
    await route.fulfill({ json: { ...body, instructions: "Keep the gates latched." } });
  });
}

async function richChat(page: Page) {
  await assistants(page)
    .getByRole("button", { name: /Ranch Hand/ })
    .click();
  await page.getByText("Which gate first?").waitFor();
}

/** A screen, and routes it needs before sign-in, which reads the chat last open. They take precedence over `fixtures`. */
type GuardScreen = [...Screen, ((page: Page) => Promise<void>)?];

const EXTRA: GuardScreen[] = [
  [
    "a chat with a table, an approval, a question, an attachment and Find in chat",
    async (page) => {
      await richChat(page);
      await page.locator('.composer input[type="file"]').setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Post two is loose.\n"),
      });
      await page.locator(".attachment").waitFor();
      await page.getByRole("textbox", { name: "Message Ranch Hand" }).focus();
      await page.keyboard.press("ControlOrMeta+f");
      await page.getByRole("searchbox", { name: "Find in chat" }).fill("fence");
      // The rail shows beside a chat that scrolls, at widths with room for it, and has rules of its own to read.
      if (page.viewportSize()!.width > 620)
        await expect(
          page.getByRole("navigation", { name: "Messages you sent in this chat" }),
        ).toBeVisible();
    },
  ],
  [
    "a reply with text selected for the Quote button",
    async (page) => {
      await richChat(page);
      await page.getByText("leans after the storm").evaluate((paragraph) => {
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
      });
      await page.locator(".quote-selection").waitFor();
    },
  ],
  // The live computer's Watch button sits in the activity line, whose own button rule used to outrank its class.
  [
    "a chat with the assistant at the computer",
    async (page) => {
      await assistants(page)
        .getByRole("button", { name: /Ranch Hand/ })
        .click();
      // The peek is a Watch button too; this one is in the activity line.
      await page
        .locator(".activity-status")
        .getByRole("button", { name: "Watch Ranch Hand on the computer" })
        .waitFor();
      // The peek's close button is read on this screen too. A peek that failed to open would leave the activity
      // line's Watch in place and the comparison passing without it.
      await page.getByRole("button", { name: "Hide the computer preview" }).waitFor();
    },
    async (page) => {
      await page.route(/\/api\/bots\/ranch\/conversation/, async (route) => {
        const body = await (await fresh(route)).json();
        await route.fulfill({
          json: {
            ...body,
            messages: [{ id: "lx-c1", role: "user", text: "Order more feed online." }],
            approvals: [],
            attention: [],
            activity: { state: "working", runId: "lx-run" },
            toolCalls: [{ id: "lx-call", name: "browser_navigate", status: "running" }],
          },
        });
      });
      // The peek beside it asks for the desktop, which this server has none of. Left waiting, it logs no error.
      await page.route(/\/api\/computer\/desktop/, () => {});
    },
  ],
  [
    "an assistant's settings",
    async (page) => {
      await assistants(page)
        .getByRole("button", { name: /Ranch Hand/ })
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: /Assistant settings/ }).click();
      await page
        .locator(".settings-dialog[open] .settings-content:not(.settings-load-state)")
        .waitFor();
    },
  ],
  // Every kind of group row in Bubbles, with the person's solid bubble, whose rules meet the reply bubble's.
  [
    "a group chat in bubbles with a solid bubble and a selected reply",
    async (page) => {
      await openGroup(page);
      await page
        .locator(".group-message")
        .nth(1)
        .getByRole("button", { name: /Reply in thread/ })
        .click();
      await page.locator(".group-message.selected").waitFor();
    },
    (page) => groupFixture(page, { ownBubble: "solid", chatStyle: "bubbles" }),
  ],
  [
    "a group chat in Classic",
    async (page) => {
      await openGroup(page);
    },
    (page) => groupFixture(page, { ownBubble: "solid", chatStyle: "classic" }),
  ],
];

/**
 * Replaces each stylesheet link with a style element of its rules, so the two cascades can be swapped in. A link a
 * later step's lazy screen adds is replaced the same way at the next read, before anything is read.
 */
const prepare = (page: Page) =>
  page.evaluate((layered) => {
    const unwrap = (rules: CSSRuleList): string =>
      Array.from(rules, (rule) =>
        rule instanceof CSSLayerBlockRule && layered.includes(rule.name)
          ? unwrap(rule.cssRules)
          : rule.cssText,
      ).join("\n");
    const adopted = new WeakSet<HTMLLinkElement>();
    const sheets: { style: HTMLStyleElement; layered: string; unlayered: string }[] = [];
    const adopt = () => {
      for (const link of document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")) {
        if (adopted.has(link)) continue;
        // A sheet still loading would be read as built in both cascades, and pass whatever it holds.
        if (!link.sheet) throw new Error(`${link.href} has not loaded`);
        adopted.add(link);
        const sheet = {
          style: document.createElement("style"),
          layered: Array.from(link.sheet.cssRules, (rule) => rule.cssText).join("\n"),
          unlayered: unwrap(link.sheet.cssRules),
        };
        // Filled before its link goes: a page left without its styles for a frame resizes everything the app
        // observes, and WebKit reports the observers' pile-up as uncaught errors.
        sheet.style.textContent = sheet.layered;
        link.after(sheet.style);
        link.disabled = true;
        sheets.push(sheet);
      }
    };
    adopt();
    // A control still easing toward its hover color differs by when it was read.
    const still = document.head.appendChild(document.createElement("style"));
    still.textContent =
      "*, *::before, *::after { transition: none !important; animation: none !important; }";
    still.disabled = true;
    Object.assign(window, {
      cascade: (cascade: "layered" | "unlayered", settled: boolean) => {
        adopt();
        for (const sheet of sheets)
          if (sheet.style.textContent !== sheet[cascade]) sheet.style.textContent = sheet[cascade];
        still.disabled = !settled;
      },
    });
  }, LAYERED);

/**
 * Reads every element under the built cascade and the unlayered one and returns what moved, with a second built read
 * to drop anything still arriving on its own. Settled, transitions and animations are off and everything else is
 * read; otherwise only the transition and animation properties are, which name what would run, not where it is.
 * The comparison stays in the page: the reads hold hundreds of thousands of values.
 */
const compare = (page: Page, settled: boolean) =>
  page.evaluate((settled) => {
    const swap = (window as unknown as { cascade: (c: string, s: boolean) => void }).cascade;
    // Every computed style lists the same properties, so the ones compared are chosen once.
    const all = getComputedStyle(document.body);
    const names = Array.from({ length: all.length }, (_, index) => all[index]!).filter(
      (property) =>
        !property.startsWith("--") && /^(transition|animation)/.test(property) !== settled,
    );
    // Each element and drawn pseudo-element's values, in the order of `names`, and joined, so an element that did
    // not move costs one string comparison.
    type Values = { values: string[]; joined: string };
    const read = (cascade: string) => {
      swap(cascade, settled);
      const found = new Map<string, Values>();
      const walk = (element: Element, path: string) => {
        for (const pseudo of [null, "::before", "::after"]) {
          const style = getComputedStyle(element, pseudo);
          if (pseudo && ["none", "normal", ""].includes(style.content)) continue;
          const values = names.map((property) => {
            const value = style.getPropertyValue(property);
            return value.includes('url("#') ? value.replace(/url\("#[^"]*"\)/g, "url(#id)") : value;
          });
          found.set(`${path}${pseudo ?? ""}`, { values, joined: values.join("\u0001") });
        }
        [...element.children]
          .filter((child) => !["SCRIPT", "STYLE", "LINK"].includes(child.tagName))
          .forEach((child, index) =>
            walk(
              child,
              `${path} > ${child.tagName.toLowerCase()}${[...child.classList].map((name) => `.${name}`).join("")}:${index}`,
            ),
          );
      };
      walk(document.body, "body");
      return found;
    };
    const layered = read("layered");
    const unlayered = read("unlayered");
    type Move = { element: string; at: number };
    const moved: Move[] = [];
    // Both reads' elements: generated content that only one cascade draws is missing from the other.
    for (const element of new Set([...layered.keys(), ...unlayered.keys()])) {
      const a = layered.get(element),
        b = unlayered.get(element);
      if (a?.joined === b?.joined) continue;
      names.forEach((_, at) => {
        if (a?.values[at] !== b?.values[at]) moved.push({ element, at });
      });
    }
    let settledMoves = moved;
    if (moved.length) {
      const again = read("layered");
      settledMoves = moved.filter(
        ({ element, at }) => again.get(element)?.values[at] === layered.get(element)?.values[at],
      );
    }
    swap("layered", true);
    const shown = (read: Map<string, Values>, { element, at }: Move) =>
      read.get(element)?.values[at] ?? "(not drawn)";
    return {
      count: layered.size * names.length,
      moved: settledMoves.map(
        (move) =>
          `${move.element} ${names[move.at]} ${shown(layered, move)} -> ${shown(unlayered, move)} without layers`,
      ),
    };
  }, settled);

const CONTROLS =
  "button, a, input, textarea, select, summary, label, [tabindex], [role=menuitem], [role=option], [role=tab], [role=switch]";

/** Forces a state on every control through the DevTools protocol, which only Chromium has. */
async function force(cdp: CDPSession, state: string | null) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: CONTROLS,
  });
  await Promise.all(
    nodeIds.map((nodeId) =>
      cdp
        .send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: state ? [state] : [] })
        // A control the page removed since the list was read, as the command palette does with its results, has
        // no state to force and is not read either. Any other protocol error still fails the test.
        .catch((error: unknown) => {
          if (!/Could not find node with given id/.test(String(error))) throw error;
        }),
    ),
  );
}

// Wide and narrow, in both schemes, and a finger at phone width, since many of these rules are phone- or touch-only.
// Motion is allowed in two of them, so the motion layer's own rules are read too.
const VIEWS = [
  {
    name: "wide, light",
    width: 1280,
    height: 800,
    colorScheme: "light",
    reducedMotion: "no-preference",
  },
  { name: "wide, dark", width: 1280, height: 800, colorScheme: "dark", reducedMotion: "reduce" },
  { name: "phone, dark", width: 390, height: 844, colorScheme: "dark", reducedMotion: "reduce" },
  {
    name: "phone with a finger, light",
    width: 390,
    height: 844,
    colorScheme: "light",
    reducedMotion: "no-preference",
    touch: true,
  },
] as const;

for (const view of VIEWS) {
  test.describe(view.name, () => {
    test.use({
      viewport: { width: view.width, height: view.height },
      hasTouch: "touch" in view,
      isMobile: "touch" in view,
    });
    const screens: StatefulScreen[] = [
      ...([...SCREENS, ...EXTRA] as GuardScreen[]).map(([name, reach, before]) => ({
        name,
        before,
        steps: [{ name: "", reach }],
      })),
      ...STATEFUL,
    ];
    for (const { name, before, steps, allowConsoleError: allowed = [] } of screens) {
      test(`${name} reads the same without cascade layers`, async ({
        page,
        browserName,
        allowConsoleError,
      }) => {
        allowConsoleError.push(...allowed);
        await page.emulateMedia({
          colorScheme: view.colorScheme,
          reducedMotion: view.reducedMotion,
        });
        await fixtures(page);
        await before?.(page);
        await signIn(page);
        const cdp =
          browserName === "chromium" ? await page.context().newCDPSession(page) : undefined;
        if (cdp) await Promise.all([cdp.send("DOM.enable"), cdp.send("CSS.enable")]);
        const moved: string[] = [];
        let prepared = false;
        // Each step builds on the one before it in the same page, which is read again after each.
        for (const step of steps) {
          if (prepared) {
            if (cdp) await force(cdp, null);
            // Motion back on, for a step that waits on a transition or an animation to end.
            await page.evaluate(() =>
              (window as unknown as { cascade: (c: string, s: boolean) => void }).cascade(
                "layered",
                false,
              ),
            );
          }
          await step.reach(page);
          // The pointer leaves the control the step pressed last, which would otherwise read hovered at rest.
          await page.mouse.move(0, 0);
          if (!prepared) {
            // A theme the member saved outranks the emulated scheme, and a light view read dark would pass unseen.
            expect(
              await page.evaluate(() => ({
                theme: document.documentElement.dataset.theme,
                dark: matchMedia("(prefers-color-scheme: dark)").matches,
              })),
              `${view.name} reads the scheme it emulates`,
            ).toEqual({ theme: "system", dark: view.colorScheme === "dark" });
            await prepare(page);
          }
          prepared = true;
          const label = (state: string | null) =>
            [step.name, state ?? "at rest"].filter(Boolean).join(", ");
          const states =
            cdp && step.states !== false ? [null, "hover", "focus-visible", "active"] : [null];
          for (const state of states) {
            if (cdp) await force(cdp, state);
            for (const settled of state ? [true] : [true, false]) {
              const read = await compare(page, settled);
              expect(read.count, `${name} read nothing`).toBeGreaterThan(100);
              moved.push(...read.moved.map((line) => `${label(state)}: ${line}`));
            }
          }
        }
        expect(moved).toEqual([]);
      });
    }
  });
}

// The guard's own check: a pseudo-element that only one cascade draws has to read as a difference, whichever one it is.
test("the guard sees generated content that only one cascade draws", async ({ page }) => {
  await signIn(page);
  // Added to a built sheet: the page's content security policy refuses a stylesheet from anywhere else.
  await page.evaluate(() => {
    const sheet = document.querySelector<HTMLLinkElement>("link[rel=stylesheet]")!.sheet!;
    for (const rule of [
      // Before layers the more specific base rule drew it; in layers the component rule hides it.
      "@layer base { .probe-a .probe::before { content: 'a'; } }",
      "@layer components { .probe::before { content: none; } }",
      // Before layers the more specific component rule hid it; in layers the motion rule draws it.
      "@layer components { .probe-b .probe::after { content: none; } }",
      "@layer motion { .probe::after { content: 'b'; } }",
    ])
      sheet.insertRule(rule, sheet.cssRules.length);
    for (const name of ["probe-a", "probe-b"]) {
      const outer = document.body.appendChild(document.createElement("div"));
      outer.className = name;
      outer.appendChild(document.createElement("span")).className = "probe";
    }
  });
  await prepare(page);
  const { moved } = await compare(page, true);
  const content = (side: string) =>
    moved.filter((line) => line.includes(`> div.${side}:`) && / content /.test(line));
  expect(content("probe-a")).toEqual([
    expect.stringMatching(/span\.probe:0::before content \(not drawn\) -> "a" without layers$/),
  ]);
  expect(content("probe-b")).toEqual([
    expect.stringMatching(/span\.probe:0::after content "b" -> \(not drawn\) without layers$/),
  ]);
});
