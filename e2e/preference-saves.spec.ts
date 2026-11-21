import { expect, signIn, test } from "./fixtures.js";

// The server reads a preferences body sent as application/json as a whole object and clears what it leaves out,
// so a Settings change must reach it as a merge patch that names only the field the person changed.
test("a Settings change reaches the server as a merge patch of that field alone", async ({
  page,
}) => {
  await signIn(page);
  const read = () =>
    page.evaluate(
      async () =>
        ((await (await fetch("/api/bootstrap")).json()) as { preferences: { theme?: string } })
          .preferences,
    );
  const before = await read();
  await page.getByRole("button", { name: "Account" }).click();
  await page
    .getByRole("menu", { name: "Account" })
    .getByRole("menuitem", { name: "Settings" })
    .click();
  const appearance = page.getByRole("combobox", { name: "Appearance" });
  const next = before.theme === "light" ? "dark" : "light";
  const saving = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && new URL(request.url()).pathname === "/api/preferences",
  );
  await appearance.selectOption(next);
  const request = await saving;
  expect(request.headers()["content-type"]).toBe("application/merge-patch+json");
  expect(request.postDataJSON()).toEqual({ theme: next });
  expect((await request.response())?.status()).toBe(200);
  expect(await read()).toEqual({ ...before, theme: next });
  // Later tests start from the theme this one found.
  await appearance.selectOption(before.theme ?? "system");
  await expect.poll(async () => (await read()).theme).toBe(before.theme);
});
