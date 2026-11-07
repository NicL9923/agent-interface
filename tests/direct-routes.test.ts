import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { connect, type TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkInterfaceInfo } from "node:os";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { directAddresses, loadDirectIdentity, type DirectAddress } from "../src/server/direct-routes.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const directories: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const scratch = () => { const directory = mkdtempSync(join(tmpdir(), "direct-routes-")); directories.push(directory); return directory; };

const nic = (address: string, extra: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo => ({
  address, family: address.includes(":") ? "IPv6" : "IPv4", internal: false, netmask: "", mac: "00:00:00:00:00:00", cidr: null, ...extra,
} as NetworkInterfaceInfo);

describe("direct route addresses", () => {
  it("advertises Tailscale and household LAN addresses and nothing a phone could not reach", () => {
    const interfaces = {
      lo: [nic("127.0.0.1", { internal: true })],
      // Linux names the adapter; with IPv6 disabled the name is all there is.
      tailscale0: [nic("100.101.102.103")],
      // macOS: Tailscale is a utun known only by its IPv6 prefix.
      utun3: [nic("100.90.1.2"), nic("fd7a:115c:a1e0::2")],
      // Another VPN in the carrier-NAT range is not a tailnet.
      utun4: [nic("100.70.0.9")],
      // Carrier NAT on an ordinary adapter is not a tailnet either.
      wwan0: [nic("100.65.4.4")],
      en0: [nic("192.168.1.20"), nic("fe80::1")],
      eth1: [nic("10.0.0.5"), nic("172.20.1.1")],
      eth2: [nic("172.32.0.1"), nic("192.169.0.1"), nic("203.0.113.9")],
      docker0: [nic("172.17.0.1")],
      "br-1a2b": [nic("172.18.0.1")],
      wg0: [nic("10.8.0.1")],
      // An address on two adapters is advertised once.
      en1: [nic("192.168.1.20")],
    };
    expect(directAddresses(interfaces, ["lan", "tailnet"])).toEqual([
      { kind: "tailnet", address: "100.101.102.103" },
      { kind: "tailnet", address: "100.90.1.2" },
      { kind: "lan", address: "192.168.1.20" },
      { kind: "lan", address: "10.0.0.5" },
      { kind: "lan", address: "172.20.1.1" },
    ]);
    // A VPS turns on only its tailnet: its provider's private network is no household's LAN.
    expect(directAddresses(interfaces, ["tailnet"]).map(entry => entry.kind)).toEqual(["tailnet", "tailnet"]);
    expect(directAddresses(interfaces, ["lan"]).every(entry => entry.kind === "lan")).toBe(true);
  });
});

describe("direct route identity", () => {
  it("makes an owner-private, self-signed P-256 certificate once and keeps it", () => {
    const directory = scratch();
    const first = loadDirectIdentity(directory);
    const certificate = new X509Certificate(first.cert);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(first.fingerprint).toBe(createHash("sha256").update(certificate.raw).digest("base64url"));
    expect(statSync(join(directory, "key.pem")).mode & 0o777).toBe(0o600);
    expect(loadDirectIdentity(directory).fingerprint).toBe(first.fingerprint);
  });

  it("replaces a key that does not match its certificate instead of serving a broken pair", () => {
    const directory = scratch();
    const first = loadDirectIdentity(directory);
    writeFileSync(join(directory, "key.pem"), generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }));
    const warn = vi.fn();
    const second = loadDirectIdentity(directory, { warn });
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(new X509Certificate(readFileSync(join(directory, "cert.pem"))).checkPrivateKey(
      createPrivateKey(readFileSync(join(directory, "key.pem"))))).toBe(true);
    expect(warn).toHaveBeenCalledWith({ directory }, expect.stringContaining("do not match"));
  });

  it("replaces an unreadable certificate", () => {
    const directory = scratch();
    const first = loadDirectIdentity(directory);
    writeFileSync(join(directory, "cert.pem"), "not a certificate");
    expect(loadDirectIdentity(directory).fingerprint).not.toBe(first.fingerprint);
  });
});

describe("direct route config", () => {
  const base = { APP_DATABASE: "/srv/wildbots/data/app.sqlite" };
  it("is off unless asked for, and keeps its key beside the database by default", () => {
    expect(loadConfig(base).directRoutes).toBeUndefined();
    expect(loadConfig({ ...base, DIRECT_ROUTES: "tailnet, lan,tailnet" }).directRoutes).toEqual({
      kinds: ["tailnet", "lan"], port: 3443, stateDirectory: "/srv/wildbots/data/direct-tls" });
  });
  it.each([
    [{ DIRECT_ROUTES: "lan,wifi" }, "DIRECT_ROUTES must list"],
    [{ DIRECT_ROUTES: " , " }, "DIRECT_ROUTES must list"],
    [{ DIRECT_ROUTES: "lan", DIRECT_PORT: "70000" }, "DIRECT_PORT must be a port"],
    [{ DIRECT_ROUTES: "lan", DIRECT_PORT: "3000" }, "DIRECT_PORT must differ from PORT"],
    [{ DIRECT_PORT: "3443" }, "require DIRECT_ROUTES"],
    [{ DIRECT_ROUTES: "lan", APP_DATABASE: ":memory:" }, "DIRECT_TLS_DIR is required"],
  ])("refuses %o", (env, reason) => {
    expect(() => loadConfig({ ...base, ...env })).toThrow(reason);
  });
});

describe("direct route listener", () => {
  async function installation(addresses: DirectAddress[] = [{ kind: "lan", address: "127.0.0.1" }]) {
    let current = addresses;
    const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:", DIRECT_ROUTES: "lan,tailnet", DIRECT_TLS_DIR: scratch() });
    config.directRoutes!.port = 0;
    const runtime = fakeRuntime({ close: async () => {} });
    const result = await createApp(config, runtime, { background: false, directAddresses: () => current });
    closers.push(() => result.app.close());
    await result.app.ready();
    await result.directRoutes!.start(3_600_000);
    const token = randomBytes(32).toString("base64url");
    result.store.user({ id: "local-one", name: "One", email: "one@localhost.invalid" });
    result.store.nativeSession(hash(token), "local-one", Date.now() + 600_000);
    return { ...result, token, setAddresses: (next: DirectAddress[]) => { current = next; } };
  }

  /** A request to a direct route that trusts only the advertised certificate, as the app does. */
  function call(url: string, path: string, headers: Record<string, string>, pin: string) {
    return new Promise<{ status: number; body: { code?: string; routes?: unknown[] } }>((resolve, reject) => {
      const req = request(`${url}${path}`, { headers, rejectUnauthorized: false }, res => {
        const presented = (res.socket as TLSSocket).getPeerCertificate().raw;
        if (createHash("sha256").update(presented).digest("base64url") !== pin) return reject(new Error("Pin mismatch"));
        let text = "";
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : {} }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("serves the signed-in native API with the certificate it advertises", async () => {
    const { directRoutes, token } = await installation();
    const [route] = directRoutes!.routes();
    expect(route).toMatchObject({ kind: "lan", url: expect.stringMatching(/^https:\/\/127\.0\.0\.1:\d+$/) });
    const result = await call(route.url, "/api/native/routes", { authorization: `Bearer ${token}` }, route.certificateSha256);
    expect(result.status).toBe(200);
    expect(result.body.routes).toEqual([route]);
  });

  it("lists LAN routes before tailnet routes and none when it is off", async () => {
    const { directRoutes, setAddresses } = await installation([{ kind: "tailnet", address: "127.0.0.1" }, { kind: "lan", address: "127.0.0.2" }]);
    expect(directRoutes!.routes().map(route => route.kind)).toEqual(["lan", "tailnet"]);
    setAddresses([]);
    const off = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), fakeRuntime({ close: async () => {} }), { background: false });
    closers.push(() => off.app.close());
    const headers = await localLogin(off.app, "http://127.0.0.1:3000");
    expect((await off.app.inject({ url: "/api/native/routes", headers })).json()).toEqual({ routes: [] });
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  it.each([
    ["no credential", "/api/native/routes", () => ({})],
    ["a malformed bearer", "/api/native/routes", () => ({ authorization: "Bearer short" })],
    ["a browser cookie beside the bearer", "/api/native/routes", (token: string) => ({ ...bearer(token), cookie: "session=abc" })],
    ["a browser Origin beside the bearer", "/api/native/routes", (token: string) => ({ ...bearer(token), origin: "https://192.168.1.20:3443" })],
    ["a web page", "/", bearer],
    ["the native viewer page", "/native/computer", bearer],
  ])("refuses %s", async (_reason, path, headers: (token: string) => Record<string, string>) => {
    const { directRoutes, token } = await installation();
    const [route] = directRoutes!.routes();
    const result = await call(route.url, path, headers(token), route.certificateSha256);
    expect(result).toEqual({ status: 403, body: expect.objectContaining({ code: "direct_route_refused" }) });
  });

  it("leaves a well-formed but unknown bearer to sign-in, which reports the session gone", async () => {
    const { directRoutes } = await installation();
    const [route] = directRoutes!.routes();
    const result = await call(route.url, "/api/native/routes", { authorization: `Bearer ${randomBytes(32).toString("base64url")}` }, route.certificateSha256);
    expect(result).toEqual({ status: 401, body: expect.objectContaining({ code: "session_expired" }) });
  });

  it("does not change the primary origin, where browsers sign in as before", async () => {
    const { app } = await installation();
    const headers = await localLogin(app, "http://127.0.0.1:3000");
    expect((await app.inject({ url: "/api/native/routes", headers })).statusCode).toBe(200);
  });

  it("closes a listener whose address went away and opens one for a new address", async () => {
    const { directRoutes, setAddresses } = await installation();
    const [old] = directRoutes!.routes();
    setAddresses([{ kind: "tailnet", address: "127.0.0.2" }]);
    await directRoutes!.reconcile();
    const routes = directRoutes!.routes();
    expect(routes).toEqual([expect.objectContaining({ kind: "tailnet", url: expect.stringContaining("https://127.0.0.2:") })]);
    const port = Number(new URL(old.url).port);
    await expect(new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => { socket.end(); resolve("open"); });
      socket.on("error", reject);
    })).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("keeps serving the routes that listen when another address cannot", async () => {
    const { directRoutes, setAddresses, app } = await installation();
    const warn = vi.spyOn(app.log, "warn");
    // TEST-NET-3 is assigned to no adapter, so listening there fails.
    setAddresses([{ kind: "lan", address: "127.0.0.1" }, { kind: "tailnet", address: "203.0.113.7" }]);
    await directRoutes!.reconcile();
    expect(directRoutes!.routes().map(route => route.kind)).toEqual(["lan"]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ address: "203.0.113.7" }), "Direct route could not listen");
  });
});
