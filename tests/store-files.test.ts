import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileSigner, type RegisteredFile } from "../src/server/file-signer.js";
import { Store } from "../src/server/store.js";
import type { FileRef, Submission } from "../src/shared/types.js";

const token = "hermes-token";
const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const open = (path = ":memory:") => {
  const store = new Store(path);
  stores.push(store);
  return store;
};
const registered = (name: string): RegisteredFile => ({
  path: `/workspace/staged/${name}`,
  name,
  mime: "image/png",
  botId: "ranch",
  kind: "upload",
  version: 1,
});
// An identifier as the earlier release signed it, with the Hermes token.
const legacy = (name: string, secret = token): FileRef => {
  const body = Buffer.from(JSON.stringify(registered(name))).toString("base64url");
  const id = `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  return { id, name, mime: "image/png", url: `/api/files/${encodeURIComponent(id)}` };
};
const row = (store: Store, sql: string, ...values: string[]) =>
  (store.db.prepare(sql).get(...values) as { value: string }).value;

describe("the file signing key", () => {
  it("is created once per database and survives reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "file-key-"));
    directories.push(directory);
    const path = join(directory, "app.sqlite");
    const first = open(path).fileKeys().current;
    expect(first.id).toMatch(/^[\w-]+$/);
    expect(first.secret.length).toBeGreaterThanOrEqual(43);
    expect(open(path).fileKeys().current).toEqual(first);
    expect(open().fileKeys().current.id).not.toBe(first.id);
  });

  it("refuses to sign without its key rather than invent one", () => {
    const store = open();
    store.db.prepare("DELETE FROM metadata WHERE key='file_key_current'").run();
    expect(() => store.fileKeys()).toThrow("The file signing key is missing");
  });
});

describe("upgrading stored file identifiers", () => {
  function seeded() {
    const store = open();
    store.user({ id: "one", email: "one@example.test", name: "One" });
    const files = fileSigner(store.fileKeys(), token);
    const current = files.signFile(registered("current.png"));
    const stale = legacy("stale.png", "rotated-away-token");
    store.saveDraft("one", "ranch", {
      text: "Look",
      attachments: [legacy("photo.png"), current, stale],
    });
    store.db.prepare("INSERT INTO drafts VALUES(?,?,?)").run("one", "broken", '{"attachments":[');
    store.db.prepare("INSERT INTO notification_events VALUES(?,?,?)").run(
      "event",
      JSON.stringify({
        id: "event",
        botId: "ranch",
        kind: "completed",
        title: "Done",
        occurredAt: "2026-11-14T00:00:00Z",
        files: [legacy("chart.png")],
      }),
      Date.now(),
    );
    store.saveAvatar(
      "ranch",
      { mode: "portrait", origin: "uploaded", src: legacy("portrait.png").url! },
      true,
    );
    store.saveAvatar(
      "other",
      { mode: "portrait", origin: "uploaded", src: "/api/files/%E0%A4%A" },
      true,
    );
    return { store, files, current, stale };
  }

  it("re-signs what the Hermes token verifies, so it no longer needs the token", () => {
    const { store, files, current, stale } = seeded();
    expect(store.upgradeFileReferences(files)).toEqual({ upgraded: 3, unreadable: 3 });
    const withoutToken = fileSigner(store.fileKeys(), undefined);
    const draft = store.draft("one", "ranch")!;
    expect(draft.attachments.map((file) => file.name)).toEqual([
      "photo.png",
      "current.png",
      "stale.png",
    ]);
    expect(withoutToken.fileValue(draft.attachments[0].id)).toEqual(registered("photo.png"));
    expect(draft.attachments[0].url).toBe(
      `/api/files/${encodeURIComponent(draft.attachments[0].id)}`,
    );
    expect(draft.attachments.slice(1)).toEqual([current, stale]);
    // A draft keeps its revision: devices holding the earlier copy are not told it changed.
    expect(draft.revision).toBe(1);
    const event = JSON.parse(
      row(store, "SELECT value FROM notification_events WHERE id=?", "event"),
    );
    expect(withoutToken.fileValue(event.files[0].id)).toEqual(registered("chart.png"));
    const avatar = store.presentation("ranch").avatar as { src: string };
    expect(
      withoutToken.fileValue(decodeURIComponent(avatar.src.slice("/api/files/".length))),
    ).toEqual(registered("portrait.png"));
    // What it cannot read stays exactly as it was.
    expect(row(store, "SELECT value FROM drafts WHERE bot_id=?", "broken")).toBe(
      '{"attachments":[',
    );
    expect(store.presentation("other").avatar).toMatchObject({ src: "/api/files/%E0%A4%A" });
  });

  it("changes nothing on a second start and without the Hermes token", () => {
    const { store, files } = seeded();
    store.upgradeFileReferences(files);
    const snapshot = () =>
      store.db
        .prepare(
          "SELECT value FROM drafts UNION ALL SELECT value FROM notification_events UNION ALL SELECT avatar FROM bot_presentation",
        )
        .all();
    const before = snapshot();
    expect(store.upgradeFileReferences(files)).toEqual({ upgraded: 0, unreadable: 3 });
    expect(store.upgradeFileReferences(fileSigner(store.fileKeys(), undefined))).toEqual({
      upgraded: 0,
      unreadable: 3,
    });
    expect(snapshot()).toEqual(before);
  });

  it("counts a draft entry that is not a file reference and leaves it", () => {
    const store = open();
    store.user({ id: "one", email: "one@example.test", name: "One" });
    store.db
      .prepare("INSERT INTO drafts VALUES(?,?,?)")
      .run("one", "ranch", JSON.stringify({ text: "", attachments: [null, { name: "no id" }] }));
    expect(store.upgradeFileReferences(fileSigner(store.fileKeys(), token))).toEqual({
      upgraded: 0,
      unreadable: 2,
    });
  });

  it("still clears the draft when a device sends the copy it held before the upgrade", () => {
    const store = open();
    store.user({ id: "one", email: "one@example.test", name: "One" });
    const held = { text: "Look", attachments: [legacy("photo.png")] };
    const { draft } = store.saveDraft("one", "ranch", held);
    store.upgradeFileReferences(fileSigner(store.fileKeys(), token));
    const sent: Submission = {
      requestId: "request",
      botId: "ranch",
      senderId: "one",
      ...held,
      draftBaseRevision: draft.revision,
    };
    store.intent(sent);
    store.receipt({ requestId: "request", status: "accepted", messageId: "message" });
    expect(store.draft("one", "ranch")).toMatchObject({
      text: "",
      attachments: [],
      reason: "sent",
    });
  });

  it.each([
    [
      "names a revision another device has moved past",
      (revision: number) => ({ draftBaseRevision: revision }),
    ],
    ["names no revision", () => ({})],
  ])("clears the draft by content when a device sends its pre-upgrade copy and %s", (_, base) => {
    const store = open();
    store.user({ id: "one", email: "one@example.test", name: "One" });
    const held = { text: "Look", attachments: [legacy("photo.png")] };
    const { draft } = store.saveDraft("one", "ranch", held);
    // Another device edits and then restores the same content, so only content equality can clear it.
    store.saveDraft("one", "ranch", { text: "Look!", attachments: held.attachments });
    store.saveDraft("one", "ranch", held);
    store.upgradeFileReferences(fileSigner(store.fileKeys(), token));
    expect(store.draft("one", "ranch")!.attachments[0]!.id).not.toBe(held.attachments[0]!.id);
    store.intent({
      requestId: "request",
      botId: "ranch",
      senderId: "one",
      ...held,
      ...base(draft.revision),
    });
    store.receipt({ requestId: "request", status: "accepted", messageId: "message" });
    expect(store.draft("one", "ranch")).toMatchObject({
      text: "",
      attachments: [],
      reason: "sent",
    });
  });

  it("treats a device saving its pre-upgrade copy as no change", () => {
    const store = open();
    store.user({ id: "one", email: "one@example.test", name: "One" });
    const held = { text: "Look", attachments: [legacy("photo.png")] };
    const { draft } = store.saveDraft("one", "ranch", held);
    store.upgradeFileReferences(fileSigner(store.fileKeys(), token));
    const upgraded = store.draft("one", "ranch")!;
    expect(store.saveDraft("one", "ranch", held, draft.revision)).toEqual({
      saved: true,
      draft: upgraded,
    });
  });

  it("keeps a draft whose attachment is a different file", () => {
    const store = open();
    store.user({ id: "one", email: "one@example.test", name: "One" });
    store.saveDraft("one", "ranch", { text: "Look", attachments: [legacy("other.png")] });
    store.upgradeFileReferences(fileSigner(store.fileKeys(), token));
    store.intent({
      requestId: "request",
      botId: "ranch",
      senderId: "one",
      text: "Look",
      attachments: [legacy("photo.png")],
    });
    store.receipt({ requestId: "request", status: "accepted", messageId: "message" });
    expect(store.draft("one", "ranch")).toMatchObject({ text: "Look" });
  });

  it("leaves submissions as sent, so a device retrying one with its earlier identifiers matches it", () => {
    const store = open();
    store.user({ id: "one", email: "one@example.test", name: "One" });
    const sent: Submission = {
      requestId: "request",
      botId: "ranch",
      senderId: "one",
      text: "Look",
      attachments: [legacy("photo.png")],
    };
    store.intent(sent);
    store.upgradeFileReferences(fileSigner(store.fileKeys(), token));
    expect(store.intent(sent)).toMatchObject({ created: false });
  });
});
