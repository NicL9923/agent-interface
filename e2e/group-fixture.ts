import type { Page, Route } from "@playwright/test";

/**
 * A group chat for the browser suite. The e2e server hosts no group coordinator, so the catalog, the room and its log
 * are scripted at the network edge. The log holds each kind of row: the person's own message with a list, a quote, a
 * link and inline code, an assistant reply with a table, a second reply from the same speaker, a hand-off, another
 * household member and a routine's post. Install the routes before sign-in. The catalog stays empty until
 * `openGroup`, because home names its list "Your chats" once a group shows, where sign-in waits for "Your assistants".
 */
export const GROUP_ROOM = "fence-crew";

const room = {
  room_id: GROUP_ROOM,
  name: "Fence crew",
  members: [
    { member_id: "ranch", profile: "ranch", handle: "ranch", display_name: "Ranch Hand" },
    { member_id: "trail", profile: "trail", handle: "trail", display_name: "Trail Cook" },
  ],
};
const at = Date.parse("2026-11-15T15:00:00Z") / 1000;
const events = [
  {
    event_id: "gx-own",
    seq: 1,
    kind: "message.user",
    actor: { kind: "user", id: "local-one" },
    payload: {
      text: "Two checks, @ranch:\n\n- Is the north gate latched?\n- Did the rain gauge reset?\n\n> Bring the spare battery.\n\nSee [the list](https://example.com/list) and run `gate status`.",
      thread_id: "gx-t1",
    },
    created_at: at,
  },
  {
    event_id: "gx-r1",
    seq: 2,
    kind: "message.member",
    actor: { kind: "member", id: "ranch" },
    payload: {
      member_id: "ranch",
      text: "The gate is latched.\n\n| Post | State |\n| --- | --- |\n| 2 | Loose |\n\nI will fix post 2 by noon.",
      thread_id: "gx-t1",
    },
    created_at: at + 60,
  },
  {
    event_id: "gx-r2",
    seq: 3,
    kind: "message.member",
    actor: { kind: "member", id: "ranch" },
    payload: { member_id: "ranch", text: "The rain gauge reads zero.", thread_id: "gx-t1" },
    created_at: at + 90,
  },
  {
    event_id: "gx-hand-off",
    seq: 4,
    kind: "room.assignment",
    actor: { kind: "gateway", id: "g" },
    payload: { lead_member_id: "ranch", member_ids: ["trail"], thread_id: "gx-t1" },
    created_at: at + 100,
  },
  {
    event_id: "gx-other",
    seq: 5,
    kind: "message.user",
    actor: { kind: "user", id: "household-two" },
    sender: { id: "household-two", name: "Casey" },
    payload: { text: "I can bring the trail mix.", thread_id: "gx-t1" },
    created_at: at + 200,
  },
  {
    event_id: "gx-brief",
    seq: 6,
    kind: "message.user",
    actor: { kind: "user", id: "cron:job-1", display_name: "[bot:ranch] Morning brief" },
    payload: { text: "Gates are shut. Low of 41°F tonight.", thread_id: "gx-cron" },
    created_at: at + 300,
  },
];

/** Pages whose catalog lists the group. */
const shown = new WeakSet<Page>();

/** The server's answer in full: a read the client already holds would come back as an empty 304. */
const fresh = (route: Route) => {
  const headers = { ...route.request().headers() };
  delete headers["if-none-match"];
  return route.fetch({ headers });
};

/** Scripts the group, and when `preferences` is given, overrides those of the signed-in person. */
export async function groupFixture(page: Page, preferences?: Record<string, unknown>) {
  shown.delete(page);
  await page.route(/\/api\/groups(\?.*)?$/, (route) =>
    route.fulfill({
      json: { supported: true, canSend: true, rooms: shown.has(page) ? [room] : [] },
    }),
  );
  await page.route(new RegExp(`/api/groups/${GROUP_ROOM}(\\?.*)?$`), (route) =>
    route.fulfill({ json: { room } }),
  );
  await page.route(new RegExp(`/api/groups/${GROUP_ROOM}/log`), (route) => {
    const since = Number(new URL(route.request().url()).searchParams.get("since") || 0);
    return route.fulfill({
      json: {
        events: events.filter((event) => event.seq > since),
        cursor: events.length,
        latest_seq: events.length,
        has_more: false,
      },
    });
  });
  // The server's own stream refuses a room it does not host. An empty stream closes at once, and the room's slow poll
  // stands in for it.
  await page.route(new RegExp(`/api/events\\?group=${GROUP_ROOM}`), (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": scripted room\n\n" }),
  );
  if (preferences)
    await page.route("**/api/bootstrap?*", async (route) => {
      const response = await fresh(route);
      const body = await response.json();
      // Before sign-in there is no session to change.
      if (!body.preferences) return route.fulfill({ response });
      await route.fulfill({
        response,
        json: { ...body, preferences: { ...body.preferences, ...preferences } },
      });
    });
}

/**
 * Shows the group on home and opens it there, once its five messages show. It stays in the page: a reload would
 * cancel the open chat's reads, which WebKit reports as an uncaught error.
 */
export async function openGroup(page: Page) {
  shown.add(page);
  // GROUPS_EVENT in src/app/use-session.ts: home reads the catalog again.
  await page.evaluate(() => window.dispatchEvent(new Event("agent-interface:groups")));
  await page.getByRole("button", { name: /^Fence crew/ }).click();
  await page.locator(".group-message").nth(4).waitFor();
}
