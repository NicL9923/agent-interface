import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { DirectRoute, DirectRouteKind } from "../shared/api.js";
import { safeError } from "./logging.js";
import type { DirectRoutesConfig } from "./config.js";

/**
 * Direct routes let the iOS app reach this server over the household LAN or a tailnet instead of
 * the public origin. Each is a separate HTTPS listener with a self-signed certificate the app pins
 * by fingerprint, learned over the already trusted primary origin. The listener serves only the
 * native bearer API: sign-in, cookies, web pages and WebSockets stay on the primary origin.
 */

export interface DirectIdentity {
  key: string;
  cert: string;
  /** base64url SHA-256 of the certificate's DER bytes: what the app pins. */
  fingerprint: string;
}

export interface DirectAddress { kind: DirectRouteKind; address: string }

// --- Certificate ---------------------------------------------------------------------------------

const derLength = (length: number) => {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const objectId = (dotted: string) => {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const value of rest) {
    const group = [value & 0x7f];
    for (let high = value >> 7; high > 0; high >>= 7) group.unshift((high & 0x7f) | 0x80);
    bytes.push(...group);
  }
  return der(0x06, Buffer.from(bytes));
};
const positiveInteger = (bytes: Buffer) => der(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const utcTime = (date: Date) => der(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const commonName = (value: string) => sequence(der(0x31, sequence(objectId("2.5.4.3"), der(0x0c, Buffer.from(value)))));
const ecdsaWithSha256 = sequence(objectId("1.2.840.10045.4.3.2"));

/**
 * A self-signed ECDSA P-256 certificate. Only its key matters to the app, which pins the whole
 * certificate, so it names no host and never expires (RFC 5280's 99991231235959Z).
 */
export function selfSignedCertificate(privateKey: KeyObject, publicKey: KeyObject, now = new Date()): Buffer {
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const name = commonName("WildBots direct route");
  const basicConstraints = sequence(objectId("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, sequence()));
  const tbs = sequence(
    der(0xa0, positiveInteger(Buffer.from([2]))),
    positiveInteger(serial),
    ecdsaWithSha256,
    name,
    sequence(utcTime(new Date(now.getTime() - 86_400_000)), der(0x18, Buffer.from("99991231235959Z"))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(basicConstraints)),
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  return sequence(tbs, ecdsaWithSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

export const certificateFingerprint = (certificateDer: Buffer) => createHash("sha256").update(certificateDer).digest("base64url");

const pem = (label: string, body: Buffer) =>
  `-----BEGIN ${label}-----\n${body.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

/**
 * Reads the listener identity, or makes one. A pair that is missing, unreadable or mismatched is
 * replaced: the app learns the new fingerprint over the primary origin, so a fresh key costs one
 * fallback, while serving a broken pair would cost every direct connection.
 */
export function loadDirectIdentity(directory: string, log?: Pick<FastifyBaseLogger, "warn">): DirectIdentity {
  const keyFile = join(directory, "key.pem"), certFile = join(directory, "cert.pem");
  try {
    const key = readFileSync(keyFile, "utf8"), cert = readFileSync(certFile, "utf8");
    const parsed = new X509Certificate(cert);
    if (parsed.checkPrivateKey(createPrivateKey(key))) return { key, cert, fingerprint: certificateFingerprint(parsed.raw) };
    log?.warn({ directory }, "Direct route key and certificate do not match; making a new pair");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log?.warn({ directory, error: safeError(error) }, "Direct route identity is unreadable; making a new pair");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const certificate = selfSignedCertificate(privateKey, publicKey);
  const key = privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert = pem("CERTIFICATE", certificate);
  // Written aside and renamed, so a crash never leaves a key beside another key's certificate.
  writeFileSync(`${keyFile}.tmp`, key, { mode: 0o600 });
  writeFileSync(`${certFile}.tmp`, cert, { mode: 0o600 });
  renameSync(`${keyFile}.tmp`, keyFile);
  renameSync(`${certFile}.tmp`, certFile);
  return { key, cert, fingerprint: certificateFingerprint(certificate) };
}

// --- Addresses -----------------------------------------------------------------------------------

/** Container, VM and VPN adapters: their private addresses are not the household's network. */
const virtualInterface = /^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxdbr|incusbr|podman|cni|flannel|cali|weave|kube|wg|tun|tap|zt|utun|ipsec|ppp|bridge|awdl|llw|anpi|ap\d)/i;
const ipv4 = (address: string) => address.split(".").map(Number);
const isPrivateLan = (address: string) => {
  const [a, b] = ipv4(address);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};
/** Tailscale names its Linux and Windows adapters; on macOS it is a utun known by its ULA prefix. */
const isTailscale = (name: string, entries: NetworkInterfaceInfo[]) =>
  /^tailscale/i.test(name) || entries.some(entry => entry.family === "IPv6" && /^fd7a:115c:a1e0:/i.test(entry.address));

/**
 * The IPv4 addresses a phone could reach this server at, by kind. A tailnet address must sit on a
 * Tailscale adapter, because carrier NAT and other VPNs share Tailscale's 100.64.0.0/10 range; a LAN
 * address must be RFC 1918 on an adapter that is not a container bridge or a VPN.
 */
export function directAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, kinds: readonly DirectRouteKind[]): DirectAddress[] {
  const found = new Map<string, DirectRouteKind>();
  for (const [name, entries = []] of Object.entries(interfaces)) {
    const tailscale = isTailscale(name, entries);
    for (const entry of entries) {
      if (entry.internal || entry.family !== "IPv4" || found.has(entry.address)) continue;
      // Tailscale assigns only 100.64.0.0/10 addresses, so its adapter needs no range check.
      const kind: DirectRouteKind | undefined = tailscale ? "tailnet"
        : !virtualInterface.test(name) && isPrivateLan(entry.address) ? "lan" : undefined;
      if (kind && kinds.includes(kind)) found.set(entry.address, kind);
    }
  }
  return [...found].map(([address, kind]) => ({ kind, address }));
}

// --- Listeners -----------------------------------------------------------------------------------

/** Requests that arrived on a direct listener. Fastify's request wraps this raw message. */
const directRequests = new WeakSet<IncomingMessage>();

/** Why a direct listener refused a request. Native clients fall back to the primary origin on it. */
export const directRouteRefused = { error: "This address serves only the iOS app's signed-in API.", code: "direct_route_refused" };

/** The only sign-in routes a direct listener serves: a signed-in app renewing or ending its session. */
const directAuthRoutes = new Set(["/api/auth/native/renew", "/api/auth/logout"]);

/**
 * Registered before authentication. A direct listener answers only registered /api/ routes that
 * carry a well-formed bearer and neither a cookie nor an Origin, so browser sessions, CSRF checks,
 * static files and unknown paths never apply to it. Sign-in routes, including the native code
 * exchange and local sign-in by loopback address, stay on the primary origin.
 */
export function installDirectRouteGate(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!directRequests.has(req.raw)) return;
    // The registered pattern, never the raw URL: Fastify decodes percent-escapes when it routes.
    const route = req.routeOptions.url;
    const api = route !== undefined && route.startsWith("/api/") && (!route.startsWith("/api/auth/") || directAuthRoutes.has(route));
    const bearer = /^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization ?? "");
    if (!api || !bearer || req.headers.cookie !== undefined || req.headers.origin !== undefined)
      return reply.code(403).header("Cache-Control", "no-store").send(directRouteRefused);
  });
}

interface Listener extends DirectAddress { server: Server; port?: number }

export class DirectRoutes {
  private listeners = new Map<string, Listener>();
  private timer?: NodeJS.Timeout;
  private reconciling?: Promise<void>;
  private closed = false;
  constructor(
    private readonly config: DirectRoutesConfig,
    private readonly identity: DirectIdentity,
    private readonly handle: (req: IncomingMessage, res: ServerResponse) => void,
    private readonly log: Pick<FastifyBaseLogger, "info" | "warn">,
    private readonly discover: () => DirectAddress[] = () => directAddresses(networkInterfaces(), config.kinds),
  ) {}

  /** The routes with a listening server, best first: LAN, then tailnet. */
  routes(): DirectRoute[] {
    return [...this.listeners.values()]
      .filter(listener => listener.port !== undefined)
      .sort((a, b) => Number(a.kind === "tailnet") - Number(b.kind === "tailnet"))
      .map(({ kind, address, port }) => ({ kind, url: `https://${address}:${port}`, certificateSha256: this.identity.fingerprint }));
  }

  async start(intervalMs = 60_000) {
    if (this.timer || this.closed) return;
    await this.reconcile();
    // A close during that first pass wins; another start may also have won the race.
    if (this.timer || this.closed) return;
    // Addresses come and go with DHCP leases and Tailscale restarts.
    this.timer = setInterval(() => void this.reconcile(), intervalMs);
    this.timer.unref();
  }

  /** Opens a listener for each new address and closes those whose address went away. */
  reconcile(): Promise<void> {
    this.reconciling ??= this.reconcileOnce().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }

  private async reconcileOnce() {
    let wanted: DirectAddress[];
    try { wanted = this.discover(); }
    catch (error) { this.log.warn({ error: safeError(error) }, "Direct route addresses could not be read"); return; }
    const keep = new Set(wanted.map(entry => entry.address));
    await Promise.all([...this.listeners].filter(([address]) => !keep.has(address)).map(async ([address, listener]) => {
      this.listeners.delete(address);
      await closeServer(listener.server);
      this.log.info({ address }, "Direct route closed");
    }));
    await Promise.all(wanted.filter(entry => !this.listeners.has(entry.address)).map(async entry => {
      if (this.closed) return;
      // No reverse proxy stands in front of these, so the listener sets its own limits. Node's
      // request timeout covers receiving a request, not an event stream's response, so it stays.
      const server = createServer({ key: this.identity.key, cert: this.identity.cert, minVersion: "TLSv1.2", handshakeTimeout: 10_000 }, (req, res) => {
        directRequests.add(req);
        this.handle(req, res);
      });
      server.headersTimeout = 20_000;
      server.maxHeadersCount = 100;
      // A household's devices, each with a few requests and event streams.
      server.maxConnections = 256;
      const listener: Listener = { ...entry, server };
      this.listeners.set(entry.address, listener);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.config.port, entry.address, () => { server.off("error", reject); resolve(); });
        });
        listener.port = (server.address() as { port: number }).port;
        server.on("error", error => this.log.warn({ address: entry.address, error: safeError(error) }, "Direct route listener failed"));
        this.log.info({ kind: entry.kind, address: entry.address, port: listener.port }, "Direct route listening");
      } catch (error) {
        // Retried at the next reconcile, such as after another process frees the port.
        this.listeners.delete(entry.address);
        this.log.warn({ kind: entry.kind, address: entry.address, error: safeError(error) }, "Direct route could not listen");
      }
    }));
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.reconciling;
    await Promise.all([...this.listeners.values()].map(listener => closeServer(listener.server)));
    this.listeners.clear();
  }
}

function closeServer(server: Server) {
  return new Promise<void>(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    // Event streams hold connections open for hours; closing the listener alone would wait for them.
    server.closeAllConnections();
  });
}
