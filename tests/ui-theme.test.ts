import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";
import { beforeAll, expect, it } from "vitest";

let compiler: Awaited<ReturnType<typeof compile>>;
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  compiler = await compile(await readFile(resolve("src/ui.css"), "utf8"), {
    base: resolve("src"),
    async loadStylesheet(id, base) {
      const path = require.resolve(id, { paths: [base] });
      return { path, base: dirname(path), content: await readFile(path, "utf8") };
    },
  });
});

it("compiles shadcn surface/foreground pairs against the live app palette", () => {
  const colors = {
    background: "surface", foreground: "ink", card: "raised", "card-foreground": "ink",
    popover: "raised", "popover-foreground": "ink", primary: "accent", "primary-foreground": "surface",
    secondary: "rail", "secondary-foreground": "ink", muted: "rail", "muted-foreground": "muted",
    accent: "accent-soft", "accent-foreground": "ink", destructive: "danger", "destructive-foreground": "surface",
    border: "line", input: "line", ring: "accent", brand: "accent", "muted-text": "muted",
  };
  const css = compiler.build(Object.keys(colors).map(name => `tw:bg-${name}`));
  for (const [name, variable] of Object.entries(colors)) {
    expect(css).toContain(`.tw\\:bg-${name} {\n    background-color: var(--${variable});`);
  }
});

it("compiles dark variants for the explicit dark setting and media-gated system setting", () => {
  const css = compiler.build(["tw:dark:bg-primary"]);
  expect(css).toContain('.tw\\:dark\\:bg-primary:where(:root[data-theme="dark"], :root[data-theme="dark"] *)');
  expect(css).toContain('@media (prefers-color-scheme: dark) {\n    .tw\\:dark\\:bg-primary:where(:root[data-theme="system"], :root[data-theme="system"] *)');
});

it("requires the utility prefix even when existing semantic classes are scanned", () => {
  const css = compiler.build(["inline", "block", "z-30", "tw:z-30"]);
  expect(css).toContain(".tw\\:z-30");
  expect(css).not.toMatch(/\.(inline|block|z-30)\s*\{/);
});
