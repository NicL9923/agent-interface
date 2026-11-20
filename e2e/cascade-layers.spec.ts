import type { CDPSession, Page, Route } from "@playwright/test";
import { assistants, expect, signIn, test } from "./fixtures.js";
import { SCREENS, type Screen } from "./screens.js";

// The app's own stylesheets sit in the base, components and motion cascade layers, and the layers rank by name
// before specificity. The rules were written to meet by specificity and position, as they did before #457 added the
// layers, so a base rule that used to win by being more specific now loses to any component rule, and a component
// rule loses to the motion layer the same way. Each screen below is read with the layers as built and with those
// three layers' blocks unwrapped in place, which is how the same rules met before layers, and no computed value may
// move. Chromium also reads every control hovered, focused from the keyboard and pressed, since most of these
// rules are states: the base button hover beat any one-class background on a button before layers, and does not now.
//
// When a value moves, find the two rules that set it (the failure names the element, property and both values) and put
// the losing one in the winner's layer, beside it, so specificity decides again. Never fix it with !important.

const LAYERED = ["base", "components", "motion"];

// The routes below give screens their content. Worker-owned requests bypass page routing in WebKit, so the worker
// is blocked, as in bot-exchanges.spec.ts.
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
];

/** Replaces each stylesheet link with a style element of its rules, once, so the two cascades can be swapped in. */
const prepare = (page: Page) =>
  page.evaluate((layered) => {
    const links = [...document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")];
    const unwrap = (rules: CSSRuleList): string =>
      Array.from(rules, (rule) =>
        rule instanceof CSSLayerBlockRule && layered.includes(rule.name)
          ? unwrap(rule.cssRules)
          : rule.cssText,
      ).join("\n");
    const sheets = links.map((link) => ({
      layered: Array.from(link.sheet!.cssRules, (rule) => rule.cssText).join("\n"),
      unlayered: unwrap(link.sheet!.cssRules),
    }));
    const styles = links.map((link) => {
      const style = document.createElement("style");
      link.after(style);
      link.disabled = true;
      return style;
    });
    // A control still easing toward its hover color differs by when it was read.
    const still = document.head.appendChild(document.createElement("style"));
    still.textContent =
      "*, *::before, *::after { transition: none !important; animation: none !important; }";
    Object.assign(window, {
      cascade: (cascade: "layered" | "unlayered", settled: boolean) => {
        styles.forEach((style, index) => {
          if (style.textContent !== sheets[index]![cascade])
            style.textContent = sheets[index]![cascade];
        });
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
    const read = (cascade: string) => {
      swap(cascade, settled);
      const found = new Map<string, string>();
      const walk = (element: Element, path: string) => {
        for (const pseudo of [null, "::before", "::after"]) {
          const style = getComputedStyle(element, pseudo);
          if (pseudo && ["none", "normal", ""].includes(style.content)) continue;
          for (const property of style)
            if (!property.startsWith("--") && /^(transition|animation)/.test(property) !== settled)
              found.set(
                `${path}${pseudo ?? ""} ${property}`,
                style.getPropertyValue(property).replace(/url\("#[^"]*"\)/g, "url(#id)"),
              );
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
    // Both reads' keys: generated content that only one cascade draws leaves its keys out of the other.
    let moved = [...new Set([...layered.keys(), ...unlayered.keys()])].filter(
      (key) => layered.get(key) !== unlayered.get(key),
    );
    if (moved.length) {
      const again = read("layered");
      moved = moved.filter((key) => again.get(key) === layered.get(key));
    }
    swap("layered", true);
    const shown = (value: string | undefined) => value ?? "(not drawn)";
    return {
      count: layered.size,
      moved: moved.map(
        (key) => `${key} ${shown(layered.get(key))} -> ${shown(unlayered.get(key))} without layers`,
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
      cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: state ? [state] : [] }),
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
    for (const [name, reach, before] of [...SCREENS, ...EXTRA] as GuardScreen[]) {
      test(`${name} reads the same without cascade layers`, async ({
        page,
        browserName,
        allowPageError,
      }) => {
        // Swapping the cascade resizes things the app observes, in the same frame its observers answer. WebKit
        // reports that as an uncaught error. The same screens opened without the swap raise none.
        allowPageError.push(/^ResizeObserver loop completed with undelivered notifications\.$/);
        await page.emulateMedia({
          colorScheme: view.colorScheme,
          reducedMotion: view.reducedMotion,
        });
        await fixtures(page);
        await before?.(page);
        await signIn(page);
        await reach(page);
        await prepare(page);
        const cdp =
          browserName === "chromium" ? await page.context().newCDPSession(page) : undefined;
        if (cdp) await Promise.all([cdp.send("DOM.enable"), cdp.send("CSS.enable")]);
        const moved: string[] = [];
        for (const state of cdp ? [null, "hover", "focus-visible", "active"] : [null]) {
          if (cdp) await force(cdp, state);
          for (const settled of state ? [true] : [true, false]) {
            const read = await compare(page, settled);
            expect(read.count, `${name} read nothing`).toBeGreaterThan(100);
            moved.push(...read.moved.map((line) => `${state ?? "at rest"}: ${line}`));
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
