import type { Page } from "@playwright/test";
import { assistants, expect, signIn, test } from "./fixtures.js";

// The build links home.css and shell.css after index.css, which holds the base styles and the motion layer; the dev
// server loads every component sheet before it. A rule that wins by position alone therefore shows in one and not the
// other. Each screen below is read as built, then with the sheets in the dev server's order, and its computed styles
// must not move. A difference names two rules of equal specificity that set the same property on the same element,
// which a check on selectors cannot find when the two selectors differ, as with Settings' notification row.
//
// `.agents/tools/diff-computed-styles.mjs` compares the build with the real dev server on the same screens.
const SCREENS: [string, (page: Page) => Promise<void>][] = [
  ["home", async () => {}],
  ["the assistant menu", async page => {
    await assistants(page).getByRole("button", { name: /Trail Cook/ }).click({ button: "right" });
    await page.locator(".bot-menu").waitFor();
  }],
  ["the account menu", async page => {
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menu", { name: "Account" }).waitFor();
  }],
  ["Settings", async page => {
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: /Settings/ }).click();
    await page.locator(".settings-sheet[open]").waitFor();
  }],
  ["the command palette", async page => {
    await page.keyboard.press("Control+k");
    await page.locator(".command-palette[open]").waitFor();
  }],
  ["a chat", async page => {
    await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
    await page.getByText("Morning. The north fence is fixed.").waitFor();
    // The jump button shows only after scrolling up; a bare one carries the cascade's answer for its class.
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.className = "jump-latest";
      document.querySelector(".conversation-panel")?.appendChild(button);
    });
  }],
];

type Order = "built" | "dev" | "dev, component sheets reversed";

/**
 * Puts the page's stylesheets in the order given and reads every element. "dev" is the dev server's, where App's
 * imports run before main.tsx's own: every component sheet before index.css, which holds the base styles and the motion
 * layer. The build links home.css and shell.css after index.css instead. Among the component sheets the dev server
 * follows the import graph, the build its chunks, so they are read in the build's order and in the reverse of it.
 */
const readInOrder = (page: Page, order: Order) => page.evaluate(order => {
  const links = [...document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")];
  // A disabled link has no sheet to read, so each one's rules are kept the first time.
  const sheets = ((window as unknown as { sheetRules?: Record<string, string> }).sheetRules ??= {});
  links.forEach((link, index) => { link.dataset.order ??= String(index); sheets[link.dataset.order] ??= Array.from(link.sheet!.cssRules, rule => rule.cssText).join("\n"); });
  const isIndex = (link: HTMLLinkElement) => /\/index-[\w-]+\.css$/.test(link.href);
  const components = links.filter(link => !isIndex(link));
  const ordered = order === "built" ? links
    : [...order === "dev" ? components : components.reverse(), ...links.filter(isIndex)];
  document.querySelectorAll("style[data-order]").forEach(style => style.remove());
  for (const link of ordered) {
    const style = document.head.appendChild(document.createElement("style"));
    style.dataset.order = link.dataset.order;
    style.textContent = sheets[link.dataset.order!];
  }
  // A hovered control is still easing toward its hover color, and where it is differs by when it was read.
  const still = document.head.appendChild(document.createElement("style"));
  still.dataset.order = "transitions";
  still.textContent = "*, *::before, *::after { transition: none !important; }";
  links.forEach(link => { link.disabled = true; });
  const found: Record<string, string> = {};
  const walk = (element: Element, path: string) => {
    const style = getComputedStyle(element);
    // A custom property is read through what it feeds. An ID a component generates differs between renders.
    for (const property of style) if (!property.startsWith("--")) found[`${path} ${property}`] = style.getPropertyValue(property).replace(/url\("#[^"]*"\)/g, "url(#id)");
    [...element.children].filter(child => !["SCRIPT", "STYLE", "LINK"].includes(child.tagName)).forEach((child, index) =>
      walk(child, `${path} > ${child.tagName.toLowerCase()}${[...child.classList].map(name => `.${name}`).join("")}:${index}`));
  };
  walk(document.body, "body");
  return found;
}, order);

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme} screens read the same in the build's stylesheet order and the dev server's`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await signIn(page);
    const moved: string[] = [];
    for (const [name, reach] of SCREENS) {
      await reach(page);
      const built = await readInOrder(page, "built");
      expect(Object.keys(built).length, `${name} read nothing`).toBeGreaterThan(100);
      // Content still arriving, such as a usage line, moves between two reads of one order; only a steady value counts.
      const again = await readInOrder(page, "built");
      for (const order of ["dev", "dev, component sheets reversed"] as const) {
        const other = await readInOrder(page, order);
        for (const [key, value] of Object.entries(built)) if (again[key] === value && other[key] !== value) moved.push(`${name}, ${order}: ${key} ${value} -> ${other[key]}`);
      }
      await page.keyboard.press("Escape");
    }
    // Each line names the screen, the element's path, the property and both values.
    expect(moved).toEqual([]);
  });
}

// The lit edge is drawn with the button's own drop shadow, not in place of it.
test("the jump button keeps its drop shadow under the dark lit edge", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await signIn(page);
  const shadow = await page.evaluate(() => {
    const button = document.body.appendChild(document.createElement("button"));
    button.className = "jump-latest";
    return getComputedStyle(button).boxShadow;
  });
  // The edge is an inset, one pixel down; the drop is the button's 22 px blur.
  expect(shadow).toMatch(/inset/);
  expect(shadow).toContain("0px 6px 22px");
});
