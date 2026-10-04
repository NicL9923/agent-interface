#!/usr/bin/env node
// Run on the Linux app host with its private env file and --import tsx.
// Uses a short-lived, already confirmed app session for an existing terminal administrator.
import {randomBytes} from "node:crypto";
import {spawnSync} from "node:child_process";
import {once} from "node:events";
import {writeFileSync} from "node:fs";
import WebSocket from "ws";
import {loadConfig} from "../../src/server/config.ts";
import {Store} from "../../src/server/store.ts";
import {hash} from "../../src/server/auth.ts";
import {SystemTerminal} from "../../src/server/terminal.ts";

const receipt = process.argv[2];
if (!receipt?.startsWith("/")) throw new Error("Supply an absolute private acceptance receipt path");
const config = loadConfig(), store = new Store(config.database), terminals = new SystemTerminal(config.computerTerminal);
const user = store.db.prepare("SELECT id,email,name FROM users").all().find(row => config.householdEmails.includes(row.email.toLowerCase())
  && config.computerTerminalAdmins.includes(row.email.toLowerCase()));
if (!user) throw new Error("A terminal administrator must sign into the app once before running host acceptance");
const sessionId = terminals.sessionId(user.id);
if (spawnSync("tmux", ["-S", `${config.computerTerminal.stateDirectory}/tmux.sock`, "has-session", "-t", "=" + sessionId], {stdio: "ignore"}).status === 0)
  throw new Error("Acceptance needs an unused member terminal; it will not end an existing human shell");
const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
store.session(hash(token), user.id, csrf, Date.now() + 120000);
store.confirmSession(hash(token), Date.now());
const base = `http://127.0.0.1:${config.port}`;
const headers = {cookie: `session=${token}`, origin: config.origin, "x-csrf-token": csrf};
const checks = {}, sockets = [];
let viewerId, tookControl = false, shellCreated = false;
async function request(path, body) {
  const response = await fetch(base + "/api/computer" + path, {method: body ? "POST" : "GET", headers: {...headers, "Content-Type": "application/json"}, ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`Computer acceptance request failed with HTTP ${response.status}`);
  return response.json();
}
async function attach(ticket) {
  const url = new URL(ticket.path, base); url.protocol = "ws:";
  if (url.origin !== base.replace("http:", "ws:") || !url.pathname.startsWith("/api/computer/")) throw new Error("Invalid attachment address");
  const socket = new WebSocket(url, {headers, handshakeTimeout: 10000}); sockets.push(socket);
  await once(socket, "open"); return socket;
}
async function detach(socket) {const closed = once(socket, "close"); socket.close(1000); await closed;}
function output(socket, expected) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => done(new Error("Expected terminal output did not arrive")), 10000);
    const message = data => {
      const value = JSON.parse(data.toString());
      if (value.type === "error") return done(new Error("Terminal reported an attachment error"));
      if (value.type === "output") text += value.data;
      if (text.includes(expected)) done();
    };
    function done(error) {clearTimeout(timer); socket.off("message", message); error ? reject(error) : resolve();}
    socket.on("message", message);
  });
}
try {
  const status = await request("");
  if (!status.available || !status.running || !status.browserReady || !status.terminal.available) throw new Error("Desktop, browser and terminal must be ready");
  if (status.control.kind === "human") throw new Error("Acceptance waits until the human owner hands control back");
  checks.desktop_browser_and_terminal_ready = true;
  const ticket = await request("/desktop", {}); viewerId = ticket.viewerId;
  const desktop = await attach(ticket);
  let bytes = Buffer.alloc(0), wake;
  desktop.on("message", data => {bytes = Buffer.concat([bytes, data]); wake?.();});
  async function read(size) {
    const deadline = Date.now() + 10000;
    while (bytes.length < size) {
      if (Date.now() >= deadline) throw new Error("Native desktop handshake timed out");
      await new Promise(resolve => {wake = resolve; setTimeout(resolve, 100);});
    }
    const result = bytes.subarray(0, size); bytes = bytes.subarray(size); return result;
  }
  const version = await read(12);
  if (!version.toString().startsWith("RFB 003.")) throw new Error("Invalid native desktop protocol");
  desktop.send(Buffer.from("RFB 003.008\n"));
  const count = (await read(1))[0], security = await read(count);
  if (!security.includes(1)) throw new Error("Unexpected native desktop security protocol");
  desktop.send(Buffer.from([1]));
  if ((await read(4)).readUInt32BE() !== 0) throw new Error("Desktop security handshake failed");
  desktop.send(Buffer.from([1]));
  const init = await read(24);
  if (!init.readUInt16BE(0) || !init.readUInt16BE(2)) throw new Error("Native desktop has no dimensions");
  await read(init.readUInt32BE(20));
  checks.authenticated_native_rfb_stream = true;
  const controlled = await request("/control", {action: "take", viewerId}); tookControl = true;
  if (!controlled.control.mine) throw new Error("Takeover ownership was not confirmed");
  await request("/control", {action: "release", viewerId}); tookControl = false;
  checks.explicit_takeover_and_handback = true;
  await detach(desktop);
  const terminalTicket = await request("/terminal", {}); shellCreated = true;
  const terminal = await attach(terminalTicket);
  terminal.send(JSON.stringify({type: "resize", columns: 100, rows: 32}));
  const marker = randomBytes(8).toString("hex");
  let expected = output(terminal, "SHELL_READY=" + marker + " SIZE=31 100");
  terminal.send(JSON.stringify({type: "input", data: `export AGENT_INTERFACE_ACCEPTANCE=${marker}; printf '\\nSHELL_READY=%s SIZE=' "$AGENT_INTERFACE_ACCEPTANCE"; stty size\n`}));
  await expected; checks.app_terminal_real_shell_and_resize = true;
  await detach(terminal);
  const reconnect = await attach(await request("/terminal", {}));
  expected = output(reconnect, "RECONNECT=" + marker);
  reconnect.send(JSON.stringify({type: "input", data: `printf '\\nRECONNECT=%s\\n' "$AGENT_INTERFACE_ACCEPTANCE"\n`}));
  await expected; checks.app_terminal_detach_reconnect_preserves_shell = true;
  expected = once(reconnect, "close"); await request("/terminal/end", {sessionId}); shellCreated = false; await expected;
  checks.app_terminal_explicit_end = true;
  writeFileSync(receipt, JSON.stringify({checkedAt: new Date().toISOString(), checks}, null, 2) + "\n", {mode: 0o600});
  console.log(JSON.stringify({accepted: true, checks}));
} finally {
  if (tookControl) await request("/control", {action: "release", viewerId}).catch(() => {});
  if (shellCreated) await request("/terminal/end", {sessionId}).catch(() => {});
  for (const socket of sockets) socket.terminate();
  store.deleteSession(hash(token)); store.close();
}
