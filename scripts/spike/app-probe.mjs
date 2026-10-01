/** Real app API + isolated Hermes proof. No Runtime mock or production mutation. */
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "../../src/server/app.ts";
import { createHermesRuntime } from "../../src/server/hermes.ts";
import { loadConfig } from "../../src/server/config.ts";
const accessPath = process.env.HERMES_SPIKE_ACCESS;
assert(
  accessPath,
  "Set HERMES_SPIKE_ACCESS to the private isolated fixture access file.",
);
const access = JSON.parse(readFileSync(accessPath, "utf8"));
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(access.url).hostname),
  "Probe requires loopback Hermes.",
);
const markerPath = join(access.isolatedHome, ".agent-interface-isolated");
assert(existsSync(markerPath), "Isolated runtime marker is absent.");
assert.equal(
  readFileSync(markerPath, "utf8").trim(),
  access.marker,
  "Isolated marker does not match access file.",
);
assert(
  access.token && access.isolatedHome.includes("agent-interface"),
  "This is not the isolated fixture configuration.",
);
const temporary = mkdtempSync(join(tmpdir(), "agent-interface-app-probe-"));
const config = loadConfig({
  LOCAL_DEV_AUTH: "true",
  APP_DATABASE: join(temporary, "app.sqlite"),
});
let server = await createApp(
  config,
  createHermesRuntime({ url: access.url, token: access.token,
    qualification: process.env.HERMES_AGENT_INTERFACE_QUALIFICATION_REVISION
      ? {revision:process.env.HERMES_AGENT_INTERFACE_QUALIFICATION_REVISION,home:access.isolatedHome} : undefined }),
);
let origin;
const start = async () => {
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  origin = `http://127.0.0.1:${server.app.server.address().port}`;
  config.origin = origin;
};
await start();
const scopeFiles = [
  ...readdirSync("src/server").filter(name => name.endsWith(".ts"))
    .map(name => `src/server/${name}`),
  "src/hermes/extension.py",
  "src/hermes/dashboard.py",
  "src/hermes/service_auth.py",
  "src/hermes/qualification.py",
  "src/hermes/gateway_guard.py",
  "src/shared/types.ts",
  "src/shared/upgrades.ts",
  "src/shared/integrations.ts",
  "src/hermes/integrations.py",
  "scripts/spike/app-probe.mjs",
  "package.json",
  "package-lock.json",
].sort();
function sourceDigest() {
  const hash = createHash("sha256");
  for (const file of scopeFiles) {
    hash.update(file);
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}
const initialDigest = sourceDigest();
const report = {
  kind: "Real Fastify app and Hermes gateway, deterministic model wire fixture; no real model or image backend",
  node: process.version,
  hermesRevision: process.env.HERMES_SPIKE_REVISION ?? "b9cb268deffc97946ec11645aa622a7353dd0591",
  trackedPatchSha256: process.env.HERMES_SPIKE_PATCH_SHA256 || null,
  startedAt: new Date().toISOString(),
  checks: {},
  sourceDigestStart: initialDigest,
};
const sessions = {};
async function call(method, path, payload, member = "one") {
  const session = sessions[member];
  const headers = {
    origin,
    ...(session
      ? { cookie: session.cookie, "x-csrf-token": session.csrf }
      : {}),
  };
  const init = { method, headers };
  if (payload instanceof FormData) init.body = payload;
  else if (payload !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(origin + path, init);
  let data;
  const body = await response.text();
  try {
    data = JSON.parse(body);
  } catch {
    data = body;
  }
  if (!response.ok)
    throw new Error(
      `${method} ${path.split("/").slice(0, 5).join("/")} returned ${response.status}: ${data?.detail ?? data?.error ?? "Request failed"}`,
    );
  return { data, response };
}
async function check(name, fn) {
  try {
    const detail = await fn();
    report.checks[name] = { passed: true, ...detail };
  } catch (error) {
    report.checks[name] = {
      passed: false,
      error: String(error.message).replace(
        /\/[^\s]+agent-interface[^\s]+/g,
        "<isolated-path>",
      ),
    };
    throw error;
  }
}
async function login(member) {
  const { data, response } = await call(
    "POST",
    "/api/auth/local",
    { member },
    member,
  );
  sessions[member] = {
    cookie: response.headers.get("set-cookie").split(";")[0],
    csrf: data.csrfToken,
  };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function writeControl(path, value) {
  const temporary = path + ".tmp";
  writeFileSync(temporary, JSON.stringify(value) + "\n");
  renameSync(temporary, path);
}
async function waitCompleted(botId) {
  for (let i = 0; i < 80; i++) {
    const { data } = await call("GET", `/api/bots/${botId}/conversation`);
    if (
      !["thinking", "working", "waiting"].includes(data.activity.state) &&
      data.messages.some((m) => m.role === "assistant")
    )
      return data;
    await pause(250);
  }
  throw new Error("Work did not reach a completed/review state.");
}
function minimalPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((value, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${value}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    "xref\n0 5\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
async function nativeSetup(method, params) {
  const url = new URL("/api/ws", access.url);
  url.protocol = "ws:";
  url.searchParams.set("token", access.token);
  const socket = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Native fixture setup timed out")),
        10000,
      );
      socket.addEventListener("message", ({ data }) => {
        const frame = JSON.parse(String(data));
        if (frame.id !== 1) return;
        clearTimeout(timer);
        frame.error
          ? reject(new Error(frame.error.message))
          : resolve(frame.result);
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}
let botId, routineId;
try {
  await check("authAndCapabilities", async () => {
    await login("one");
    await login("two");
    const { data } = await call("GET", "/api/bootstrap");
    assert(data.connection.connected);
    assert(data.capabilities.chat.supported);
    assert.equal(data.household.length, 2);
    return {
      householdMembers: 2,
      imageBackendAvailable: data.capabilities.imageGeneration.supported,
    };
  });
  const name = `agent-interface-probe-${randomUUID().slice(0, 8)}`;
  botId = name;
  const input = {
    name,
    instructions: "Answer concise synthetic integration questions.",
    model: "spike-model",
    provider: "spike-fixture",
    shared: true,
  };
  await check("createAndEditSharedBot", async () => {
    const { data: bot } = await call("POST", "/api/bots", input);
    botId = bot.id;
    assert(botId.startsWith("agent-interface-probe-"));
    const updated = {
      ...input,
      instructions: "Persist these synthetic instructions.",
      description: "Disposable app integration proof",
    };
    const { data } = await call("PATCH", `/api/bots/${botId}`, updated, "two");
    assert.equal(data.instructions, updated.instructions);
    const { data: bootstrap } = await call("GET", "/api/bootstrap");
    const persisted = bootstrap.bots.find((b) => b.id === botId);
    assert.equal(persisted.instructions, updated.instructions);
    assert.equal(persisted.model, "spike-model");
    assert.equal(persisted.provider, "spike-fixture");
    assert(persisted.shared);
    return { instructionPersistence: true, sharedProviderModel: true };
  });
  await check("avatarMetadataSurvivesConfigurationEdit", async () => {
    const avatar = {
      mode: "geometric",
      shape: "pebble",
      color: "#99aabb",
      eyes: "oval",
      accessory: "hat",
      eyeWidth: 1.1,
      eyeHeight: 0.9,
      eyeSpacing: 1.2,
    };
    await call("PUT", `/api/bots/${botId}/avatar`, avatar);
    await call("PATCH", `/api/bots/${botId}`, {
      ...input,
      instructions: "Updated after custom avatar.",
    });
    const { data } = await call("GET", "/api/bootstrap");
    assert.deepEqual(data.bots.find((b) => b.id === botId).avatar, avatar);
    return { customEyeDimensions: true, avatarPreservedAfterBotEdit: true };
  });
  await check("toolsAndSkills", async () => {
    for (const kind of ["tools", "skills"]) {
      const { data: catalog } = await call("GET", `/api/bots/${botId}/${kind}`);
      assert(Array.isArray(catalog));
      const enabled = catalog.filter((x) => x.enabled).map((x) => x.id);
      await call("PUT", `/api/bots/${botId}/${kind}`, { ids: [] });
      const { data: cleared } = await call("GET", `/api/bots/${botId}/${kind}`);
      assert(
        cleared.every((x) => x.required || !x.enabled),
        `${kind} empty selection must disable all`,
      );
      await call("PUT", `/api/bots/${botId}/${kind}`, { ids: enabled });
    }
    return { catalogReadAndToggle: true };
  });
  await check("routineCrudAndExplicitRecipients", async () => {
    const routine = {
      botId,
      name: "Disposable disabled routine",
      prompt: "Public synthetic routine result",
      schedule: "0 9 1 1 *",
      enabled: false,
      recipientIds: ["local-one"],
    };
    const { data } = await call("POST", "/api/routines", routine);
    routineId = data.id;
    await call("PUT", `/api/routines/${routineId}`, {
      ...routine,
      recipientIds: ["local-two"],
    });
    const { data: all } = await call("GET", "/api/routines");
    const loaded = all.find((r) => r.id === routineId);
    assert.deepEqual(loaded.recipientIds, ["local-two"]);
    assert.equal(loaded.prompt, routine.prompt);
    assert.equal(loaded.enabled, false);
    const before = (
      await call("GET", `/api/bots/${botId}/conversation`)
    ).data.messages.filter((x) => x.role === "assistant").length;
    await call("PUT", `/api/routines/${routineId}`, {
      ...routine,
      enabled: true,
      recipientIds: ["local-two"],
    });
    const resumed = (await call("GET", "/api/routines")).data.find((r) => r.id === routineId);
    assert.equal(resumed.enabled, true, "Resume must update native scheduler state, not just the response");
    await call("PUT", `/api/routines/${routineId}`, { ...routine, enabled: false, recipientIds: ["local-two"] });
    assert.equal((await call("GET", "/api/routines")).data.find((r) => r.id === routineId).enabled, false);
    await call("PUT", `/api/routines/${routineId}`, { ...routine, enabled: true, recipientIds: ["local-two"] });
    const trigger = await fetch(
      new URL(
        `/api/cron/jobs/${encodeURIComponent(routineId)}/trigger?profile=${encodeURIComponent(botId)}`,
        access.url,
      ),
      {
        method: "POST",
        headers: { "X-Hermes-Session-Token": access.token },
        signal: AbortSignal.timeout(120000),
      },
    );
    assert.equal(trigger.status, 200);
    let discovered;
    for (let i = 0; i < 100; i++) {
      discovered = server.store.db
        .prepare(
          "SELECT id FROM notification_events WHERE json_extract(value,'$.routineId')=? AND json_extract(value,'$.kind')='completed'",
        )
        .get(routineId);
      if (discovered) break;
      await pause(250);
    }
    assert(
      discovered,
      "Actual routine completion must reach durable app discovery",
    );
    const recipients = server.store.db
      .prepare("SELECT user_id FROM outbox WHERE event_id=?")
      .all(discovered.id)
      .map((x) => x.user_id);
    assert.deepEqual(recipients, ["local-two"]);
    const after = (
      await call("GET", `/api/bots/${botId}/conversation`)
    ).data.messages.filter((x) => x.role === "assistant").length;
    assert(
      after > before,
      "Native routine result must appear in the canonical conversation",
    );
    await call("DELETE", `/api/routines/${routineId}`);
    routineId = undefined;
    return {
      nativeCrud: true,
      explicitRecipientRoundTrip: true,
      actualSchedulerExecution: true,
      canonicalRoutineDelivery: true,
      durableCompletionOutboxOnlyExplicitRecipient: true,
    };
  });
  const uploaded = [];
  await check("textPdfImageAuthenticatedDelivery", async () => {
    const specimens = [
      ["proof.txt", "text/plain", Buffer.from("Public synthetic attachment")],
      ["proof.pdf", "application/pdf", minimalPdf()],
      [
        "proof.png",
        "image/png",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6XcAAAAASUVORK5CYII=",
          "base64",
        ),
      ],
    ];
    for (const [name, mime, bytes] of specimens) {
      const form = new FormData();
      form.set("file", new Blob([bytes], { type: mime }), name);
      const { data: file } = await call(
        "POST",
        `/api/bots/${botId}/uploads`,
        form,
      );
      uploaded.push(file);
      const response = await fetch(origin + file.url, {
        headers: { cookie: sessions.one.cookie },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.equal((await fetch(origin + file.url)).status, 401);
    }
    await call("PUT", `/api/bots/${botId}/draft`, {
      text: "Synthetic preserved draft",
      attachments: uploaded,
    });
    const { data: draft } = await call("GET", `/api/bots/${botId}/draft`);
    assert.equal(draft.attachments.length, 3);
    return {
      formats: ["text", "pdf", "image"],
      authenticatedRoundTrip: true,
      longSignedIdsAccepted: true,
    };
  });
  await check("imageOnlyMessageCanonicalSenderAndAttachment", async () => {
    const image = uploaded.find((file) => file.mime === "image/png");
    assert(image);
    const requestId = randomUUID();
    const { data: receipt } = await call(
      "POST",
      `/api/bots/${botId}/messages`,
      { requestId, text: "", attachments: [image] },
    );
    assert.equal(receipt.status, "accepted");
    const conversation = await waitCompleted(botId);
    const row = conversation.messages.find(
      (message) => message.id === requestId,
    );
    assert(
      row,
      "Image-only native canonical row must bind to its durable request ID",
    );
    assert.equal(row.role, "user");
    assert.equal(row.sender?.id, "local-one");
    assert.equal(
      row.text,
      "",
      "Image-only message must not display raw @image filesystem paths",
    );
    const registered = row.files?.find(
      (file) => file.id === image.id && file.mime === "image/png",
    );
    assert(
      registered,
      "Canonical image-only message must include the registered image FileRef",
    );
    const response = await fetch(origin + registered.url, {
      headers: { cookie: sessions.one.cookie },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6XcAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    return {
      emptyTextAccepted: true,
      canonicalRequestBinding: true,
      senderPreserved: true,
      registeredImageOnCanonicalMessage: true,
      noRawImagePath: true,
      authenticatedImageBytes: true,
    };
  });
  await check("twoUserNativeApprovalAndStaleAnswer", async () => {
    await nativeSetup("config.set", {
      key: "approvals.mode",
      value: "manual",
      profile: botId,
    });
    const { data: receipt } = await call(
      "POST",
      `/api/bots/${botId}/messages`,
      { requestId: randomUUID(), text: "PROBE_APPROVAL" },
    );
    assert.equal(receipt.status, "accepted");
    let approval;
    for (let i = 0; i < 80; i++) {
      const { data } = await call("GET", `/api/bots/${botId}/conversation`);
      approval = data.approvals[0];
      if (approval) break;
      await pause(250);
    }
    assert(approval, "Native terminal policy must produce a real approval");
    await call(
      "POST",
      `/api/bots/${botId}/approvals/${approval.id}`,
      { decision: "approved" },
      "two",
    );
    const second = await fetch(
      origin + `/api/bots/${botId}/approvals/${approval.id}`,
      {
        method: "POST",
        headers: {
          origin,
          cookie: sessions.one.cookie,
          "x-csrf-token": sessions.one.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "denied" }),
      },
    );
    assert.equal(second.status, 409);
    assert.equal(server.store.approval(approval.id).userId, "local-two");
    await waitCompleted(botId);
    return {
      nativePolicyRequest: true,
      secondMemberApproved: true,
      staleOtherMemberRejected: true,
      approverAttribution: true,
    };
  });
  await check("nativeGeneratedFileAuthenticatedDelivery", async () => {
    await call("POST", `/api/bots/${botId}/messages`, {
      requestId: randomUUID(),
      text: "PROBE_FILE",
    });
    const conversation = await waitCompleted(botId);
    const generated = conversation.files.find(
      (x) => x.name === "generated-proof.txt",
    );
    assert(generated, "Actual terminal-created file must be projected");
    const response = await fetch(origin + generated.url, {
      headers: { cookie: sessions.one.cookie },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "synthetic-file-proof");
    return { actualHermesToolOutput: true, generatedBytesDelivered: true };
  });
  await check("uploadedTextUsedByNativeTask", async () => {
    await call("POST", `/api/bots/${botId}/messages`, {
      requestId: randomUUID(),
      text: "PROBE_READ",
      attachments: [uploaded.find((x) => x.mime === "text/plain")],
    });
    const conversation = await waitCompleted(botId);
    assert(
      conversation.messages.some(
        (x) =>
          x.role === "tool" && x.text.includes("Public synthetic attachment"),
      ),
      "Native tool must read the staged attachment contents",
    );
    return { nativeToolReadStagedFile: true };
  });
  await check("durableSubmissionAndCanonicalAttribution", async () => {
    const requestId = randomUUID();
    const payload = {
      requestId,
      text: "PROBE_SLOW synthetic app proof",
      attachments: uploaded,
    };
    const { data: first } = await call(
      "POST",
      `/api/bots/${botId}/messages`,
      payload,
    );
    assert.equal(first.status, "accepted");
    const { data: again } = await call(
      "POST",
      `/api/bots/${botId}/messages`,
      payload,
    );
    assert.deepEqual(again, first);
    const second = {
      requestId: randomUUID(),
      text: "Public second participant steering",
    };
    const { data: steer } = await call(
      "POST",
      `/api/bots/${botId}/messages`,
      second,
      "two",
    );
    assert.equal(steer.status, "accepted");
    const conversation = await waitCompleted(botId);
    const firstUser = conversation.messages.find((m) =>
      m.text.includes("PROBE_SLOW"),
    );
    assert.equal(firstUser?.sender?.id, "local-one");
    const steeringMessage = conversation.messages.find((m) =>
      m.text.includes("Public second participant steering"),
    );
    assert(
      steeringMessage,
      "Native canonical history did not preserve the admitted steering text",
    );
    assert.equal(steeringMessage.sender?.id, "local-two");
    const members = server.store.recipients({
      id: "proof",
      botId,
      runId: first.runId,
      kind: "completed",
      title: "Done",
      occurredAt: "",
    });
    assert.deepEqual(members.sort(), ["local-one", "local-two"]);
    return {
      duplicateReceiptStable: true,
      canonicalSenderAttribution: true,
      canonicalSteeringAttribution: true,
      sharedParticipants: 2,
      canonicalMessageCount: conversation.messages.length,
    };
  });
  await check("appRestartPreservesCanonicalConversationAndDraft", async () => {
    const before = (await call("GET", `/api/bots/${botId}/conversation`)).data;
    const restartRequest = {
      requestId: randomUUID(),
      text: "PROBE_SLOW app restart while working",
    };
    const { data: restartReceipt } = await call(
      "POST",
      `/api/bots/${botId}/messages`,
      restartRequest,
    );
    assert.equal(restartReceipt.status, "accepted");
    const { data: active } = await call(
      "GET",
      `/api/bots/${botId}/conversation`,
    );
    assert(
      ["thinking", "working"].includes(active.activity.state),
      "Restart must begin during active execution",
    );
    await server.app.close();
    server = await createApp(
      config,
      createHermesRuntime({ url: access.url, token: access.token,
        qualification: process.env.HERMES_AGENT_INTERFACE_QUALIFICATION_REVISION
          ? {revision:process.env.HERMES_AGENT_INTERFACE_QUALIFICATION_REVISION,home:access.isolatedHome} : undefined }),
    );
    await start();
    const after = await waitCompleted(botId);
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(
      after.messages.filter((m) => m.role === "user").length,
      before.messages.filter((m) => m.role === "user").length + 1,
    );
    assert.equal(after.draft.text, "Synthetic preserved draft");
    return {
      canonicalSessionStable: true,
      draftPreserved: true,
      activeHermesWorkSurvivedAppRestart: true,
      appDatabaseHasNoHistoryTable: !server.store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messages','conversations','history')",
        )
        .get(),
    };
  });
  if (process.env.HERMES_SPIKE_CONTROL_DIR) {
    await check("executorRestartNeedsExplicitReview", async () => {
      const directory = resolve(process.env.HERMES_SPIKE_CONTROL_DIR);
      assert(
        directory.startsWith(dirname(resolve(access.isolatedHome)) + "/"),
        "Executor controller must be in the isolated fixture root",
      );
      assert.equal(
        readFileSync(
          join(directory, ".agent-interface-isolated"),
          "utf8",
        ).trim(),
        access.marker,
      );
      const requestId = randomUUID();
      const { data: receipt } = await call(
        "POST",
        `/api/bots/${botId}/messages`,
        { requestId, text: "PROBE_SLOW executor interruption app proof" },
      );
      assert.equal(receipt.status, "accepted");
      const { data: active } = await call(
        "GET",
        `/api/bots/${botId}/conversation`,
      );
      assert(["thinking", "working"].includes(active.activity.state));
      const nonce = randomUUID();
      writeControl(join(directory, "restart.request.json"), { nonce });
      let restarted = false;
      for (let i = 0; i < 120; i++) {
        const path = join(directory, "restart.complete.json");
        if (
          existsSync(path) &&
          JSON.parse(readFileSync(path, "utf8")).nonce === nonce
        ) {
          restarted = true;
          break;
        }
        await pause(250);
      }
      assert(
        restarted,
        "Isolated controller did not acknowledge executor restart",
      );
      // The app intentionally backs off failed connections. Exercise automatic
      // read-only recovery instead of assuming the first post-restart read wins.
      const recoveryStarted = Date.now();
      let recovered = false;
      while (Date.now() - recoveryStarted < 45_000) {
        const { data: bootstrap } = await call("GET", "/api/bootstrap");
        if (bootstrap.connection.connected) { recovered = true; break; }
        await pause(500);
      }
      assert(recovered, "App did not automatically reconnect to the restarted executor");
      const automaticReconnectMs = Date.now() - recoveryStarted;
      const { data: interrupted } = await call(
        "GET",
        `/api/bots/${botId}/conversation`,
      );
      assert.equal(interrupted.activity.state, "interrupted");
      assert.equal(
        (await call("GET", `/api/submissions/${requestId}`)).data.status,
        "interrupted",
      );
      await pause(500);
      assert.equal(
        (await call("GET", `/api/bots/${botId}/conversation`)).data.activity
          .state,
        "interrupted",
      );
      const fresh = {
        requestId: randomUUID(),
        text: "Explicitly reviewed continuation",
      };
      const blocked = await fetch(origin + `/api/bots/${botId}/messages`, {
        method: "POST",
        headers: {
          origin,
          cookie: sessions.one.cookie,
          "x-csrf-token": sessions.one.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(fresh),
      });
      assert.equal(blocked.status, 409);
      const { data: reviewed } = await call(
        "POST",
        `/api/bots/${botId}/messages`,
        { ...fresh, reviewedInterruption: true },
      );
      assert.equal(reviewed.status, "accepted");
      await waitCompleted(botId);
      return {
        receiptInterrupted: true,
        automaticReconnectMs,
        canonicalStateInterrupted: true,
        automaticResume: false,
        unreviewedAdmissionRejected: true,
        reviewedAdmissionAccepted: true,
      };
    });
  } else {
    report.checks.executorRestartNeedsExplicitReview = {
      passed: false,
      notRun: true,
      reason:
        "Requires isolated launcher's explicit executor control directory",
    };
  }
} catch (error) {
  report.failed = true;
  console.error("App integration probe failed:", error.message);
  process.exitCode = 1;
} finally {
  if (routineId)
    try {
      await call("DELETE", `/api/routines/${routineId}`);
    } catch {}
  if (botId)
    try {
      await call("DELETE", `/api/bots/${botId}`);
      report.cleanup = { disposableBotDeleted: true };
    } catch {
      report.cleanup = { disposableBotDeleted: false };
    }
  await server.app.close();
  rmSync(temporary, { recursive: true, force: true });
  report.sourceDigest = sourceDigest();
  report.codeStateStable = report.sourceDigest === initialDigest;
  if (!report.codeStateStable) {
    report.failed = true;
    process.exitCode = 1;
  }
  writeFileSync(
    resolve(process.env.HERMES_SPIKE_EVIDENCE_DIR || "docs/evidence", "app-probe.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      evidence: resolve(process.env.HERMES_SPIKE_EVIDENCE_DIR || "docs/evidence", "app-probe.json"),
      checks: report.checks,
      failed: report.failed ?? false,
    }),
  );
}
