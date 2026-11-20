import type { Page } from "@playwright/test";
import { assistants, expect, signIn, test } from "./fixtures.js";
import { SCREENS } from "./screens.js";

// The build links home.css and shell.css after index.css, which holds the base styles and the motion layer; the dev
// server loads every component sheet before it. A rule that wins by position alone therefore shows in one and not the
// other. Each screen in e2e/screens.ts is read as built, then with index.css last and the component sheets in the reverse of the
// build's order, and its computed styles must not move. A difference names two rules of equal specificity that set the same property on the same element,
// which a check on selectors cannot find when the two selectors differ, as with Settings' notification row.
//
// `.agents/tools/diff-computed-styles.mjs` compares the build with the real dev server on the same screens, and
// e2e/cascade-layers.spec.ts reads them with and without the cascade layers.

type Order = "built" | "reversed";

/**
 * Puts the page's stylesheets in the order given and reads every element. The dev server loads every component sheet
 * before index.css, which holds the base styles and the motion layer, where the build links home.css and shell.css
 * after it; among the component sheets the dev server follows the import graph and the build its chunks. "reversed" is
 * index.css last and the component sheets in the reverse of the build's order. It flips every pair of sheets that
 * "built" has in one order, and for any property the dev server's order moves it picks the same winner, since index.css
 * is the last sheet in both. So one read in that order stands in for the dev server's, and costs one read less.
 */
const readInOrder = (page: Page, order: Order) =>
  page.evaluate((order) => {
    const links = [...document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")];
    // A disabled link has no sheet to read, so each one's rules are kept the first time.
    const sheets = ((window as unknown as { sheetRules?: Record<string, string> }).sheetRules ??=
      {});
    links.forEach((link, index) => {
      link.dataset.order ??= String(index);
      sheets[link.dataset.order] ??= Array.from(link.sheet!.cssRules, (rule) => rule.cssText).join(
        "\n",
      );
    });
    const isIndex = (link: HTMLLinkElement) => /\/index-[\w-]+\.css$/.test(link.href);
    const components = links.filter((link) => !isIndex(link));
    const ordered = order === "built" ? links : [...components.reverse(), ...links.filter(isIndex)];
    document.querySelectorAll("style[data-order]").forEach((style) => style.remove());
    for (const link of ordered) {
      const style = document.head.appendChild(document.createElement("style"));
      style.dataset.order = link.dataset.order;
      style.textContent = sheets[link.dataset.order!];
    }
    // A hovered control is still easing toward its hover color, and where it is differs by when it was read.
    const still = document.head.appendChild(document.createElement("style"));
    still.dataset.order = "transitions";
    still.textContent = "*, *::before, *::after { transition: none !important; }";
    links.forEach((link) => {
      link.disabled = true;
    });
    const found: Record<string, string> = {};
    const walk = (element: Element, path: string) => {
      const style = getComputedStyle(element);
      // A custom property is read through what it feeds. An ID a component generates differs between renders.
      for (const property of style)
        if (!property.startsWith("--"))
          found[`${path} ${property}`] = style
            .getPropertyValue(property)
            .replace(/url\("#[^"]*"\)/g, "url(#id)");
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
  }, order);

// One test per screen and scheme, each far inside the default timeout, so a slow runner has room.
for (const colorScheme of ["light", "dark"] as const) {
  for (const [name, reach] of SCREENS) {
    test(`${name} reads the same in the build's stylesheet order and the dev server's, ${colorScheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await signIn(page);
      await reach(page);
      const built = await readInOrder(page, "built");
      expect(Object.keys(built).length, `${name} read nothing`).toBeGreaterThan(100);
      const other = await readInOrder(page, "reversed");
      let moved = Object.entries(built).filter(([key, value]) => other[key] !== value);
      if (moved.length) {
        // Content still arriving, such as a usage line, moves between two reads of one order; only a steady value counts.
        const again = await readInOrder(page, "built");
        moved = moved.filter(([key, value]) => again[key] === value);
      }
      // Each line names the screen, the element's path, the property and both values.
      expect(moved.map(([key, value]) => `${name}: ${key} ${value} -> ${other[key]}`)).toEqual([]);
    });
  }
}

// A layer's rank is set where its name first appears, so the statement that ranks them has to be the first layer rule
// the page meets. A component sheet ahead of it ranks components under base, and the base `button` rule then beats
// every component's own buttons. Both orders the screens above compare would be wrong together, so they cannot see it.
test("the built app ranks its cascade layers before any layered rule", async ({ page }) => {
  await signIn(page);
  await assistants(page)
    .getByRole("button", { name: /Ranch Hand/ })
    .click();
  await page.getByText("Morning. The north fence is fixed.").waitFor();
  const read = await page.evaluate(() => {
    let first: { kind: string; names: string[] } | undefined;
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSLayerStatementRule)
          first ??= { kind: "statement", names: [...rule.nameList] };
        else if (rule instanceof CSSLayerBlockRule) first ??= { kind: "block", names: [rule.name] };
      }
      if (first) break;
    }
    // A bare button with a component's class carries the cascade's answer for that class.
    const button = document.createElement("button");
    button.className = "reply-action";
    document.querySelector(".message")?.appendChild(button);
    return { first, border: getComputedStyle(button).borderTopWidth };
  });
  expect(read.first).toEqual({
    kind: "statement",
    names: ["theme", "base", "components", "motion", "utilities"],
  });
  // The base layer gives every button a 1 px border; a reply's action button removes it.
  expect(read.border).toBe("0px");
});

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
