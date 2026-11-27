#!/usr/bin/env node
/**
 * Install, check or remove the host's metadata egress floor. Run on the host with sudo.
 *
 *   install --user NAME | --uid N   Load the agent_interface_metadata nftables table, include it
 *                                   in /etc/nftables.conf, and install its boot unit, the
 *                                   user-manager requirement and a read-only sudo rule. Idempotent.
 *   check [--user NAME] [--egress HOST:PORT]
 *                                   Compare the live table with the expected rules, then prove as
 *                                   the service user that metadata is refused while ordinary DNS
 *                                   and HTTPS egress work. Reports which persistence mode applies.
 *   remove                          Undo install. Deletes only this table and this tool's files.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TABLE = "agent_interface_metadata";
export const UNIT = "agent-interface-metadata-floor.service";
export const RULES = "/etc/nftables.d/agent-interface-metadata.nft";
export const UNIT_FILE = `/etc/systemd/system/${UNIT}`;
export const NFTABLES_CONF = "/etc/nftables.conf";
export const CONF_BACKUP = "/etc/nftables.conf.agent-interface.bak";
export const SUDOERS = "/etc/sudoers.d/agent-interface-metadata-floor";
export const NFTABLES_DROPIN =
  "/etc/systemd/system/nftables.service.d/agent-interface-metadata-floor.conf";
export const STOP_FILE = "/etc/agent-interface/nftables-stop.nft";
export const SYSTEMD = "/etc/systemd/system";
export const DROPIN_NAME = "agent-interface-metadata-floor.conf";
export const METADATA_V4 = "169.254.169.254";
export const METADATA_V6 = "fe80::a9fe:a9fe";
export const DEFAULT_EGRESS = "github.com:443";
export const BEGIN = "# BEGIN agent-interface metadata egress floor";
export const END = "# END agent-interface metadata egress floor";
export const BEGIN_LINE = `${BEGIN}: managed by .agents/tools/metadata-egress-floor.mjs.`;

export const REFUSALS = new Set(["ECONNREFUSED", "EACCES", "EPERM", "EHOSTUNREACH"]);
export const REFUSED_WITHIN_MS = 1000;
export const NO_ROUTE = new Set(["ENETUNREACH", "EADDRNOTAVAIL", "ENODEV"]);

export function userManager(uid) {
  return `user@${uid}.service`;
}

export function dropin(uid) {
  return `${SYSTEMD}/${userManager(uid)}.d/${DROPIN_NAME}`;
}

export function rules(uid) {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error("The floor needs the service user's non-root uid.");
  }
  const match = `meta skuid ${uid}`;
  return `#!/usr/sbin/nft -f
# Managed by agent-interface .agents/tools/metadata-egress-floor.mjs. Do not edit.
# Loads only table inet ${TABLE}: declaring it first makes the delete safe when it is absent,
# and the whole file applies as one transaction. Never add "flush ruleset" here.
table inet ${TABLE} {}
delete table inet ${TABLE}
table inet ${TABLE} {
\tchain output {
\t\ttype filter hook output priority filter; policy accept;
\t\t${match} ip daddr ${METADATA_V4} meta l4proto tcp reject with tcp reset
\t\t${match} ip daddr ${METADATA_V4} reject with icmpx admin-prohibited
\t\t${match} ip6 daddr ${METADATA_V6} meta l4proto tcp reject with tcp reset
\t\t${match} ip6 daddr ${METADATA_V6} reject with icmpx admin-prohibited
\t}
}
`;
}

export function expectedRules(uid) {
  const out = [];
  for (const [family, address] of [
    ["ip", METADATA_V4],
    ["ip6", METADATA_V6],
  ]) {
    for (const [l4, verdictValue] of [
      ["tcp", "tcp reset"],
      [null, "icmpx admin-prohibited"],
    ]) {
      out.push([uid, family, address, l4, verdictValue]);
    }
  }
  return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function unit(nft) {
  return `# Managed by agent-interface .agents/tools/metadata-egress-floor.mjs. Do not edit.
[Unit]
Description=Agent Interface metadata egress floor (nftables table inet ${TABLE})
After=network.target nftables.service ufw.service
# The service user's manager requires this unit, so stopping or restarting it would stop or
# restart every household service. Reload reapplies the table without touching them.
RefuseManualStop=yes

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${nft} -f ${RULES}
ExecReload=${nft} -f ${RULES}

[Install]
WantedBy=multi-user.target
`;
}

export function userDropin() {
  return `# Managed by agent-interface .agents/tools/metadata-egress-floor.mjs. Do not edit.
# Fails closed: the service user's manager, and with it the app and the shared
# browser, does not start unless the metadata egress floor loaded. See docs/Hosting.md.
[Unit]
Requires=${UNIT}
After=${UNIT}
`;
}

export function nftablesDropin(nft) {
  return `# Managed by agent-interface .agents/tools/metadata-egress-floor.mjs. Do not edit.
# Debian's nftables.service stops with a bare "nft flush ruleset". This replaces it with one
# transaction that flushes and reloads the floor, so no packet passes between the two.
[Service]
ExecStop=
ExecStop=${nft} -f ${STOP_FILE}
`;
}

export function stopRules() {
  return `#!/usr/sbin/nft -f
# Managed by agent-interface .agents/tools/metadata-egress-floor.mjs. Do not edit.
# nftables.service stops with this file: the flush and the floor commit as one transaction.
flush ruleset
include "${RULES}"
`;
}

export function sudoers(user, nft) {
  return (
    "# Managed by agent-interface .agents/tools/metadata-egress-floor.mjs. Do not edit.\n" +
    "# Read-only: lets release checks compare the live floor without a password.\n" +
    `${user} ALL=(root) NOPASSWD: ${nft} -j list table inet ${TABLE}\n`
  );
}

export function markerSpan(conf) {
  const lines = conf.split(/\r?\n/);
  const begins = [];
  const ends = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      trimmed === BEGIN_LINE ||
      trimmed === `${BEGIN}: managed by .agents/tools/metadata-egress-floor.py.`
    ) {
      begins.push(i);
    }
    if (trimmed === END) ends.push(i);
  }
  if (!begins.length && !ends.length) return null;
  if (begins.length === 1 && ends.length === 1 && begins[0] < ends[0]) {
    return [begins[0], ends[0]];
  }
  const order = begins.length === 1 && ends.length === 1 ? " out of order" : "";
  throw new Error(
    `${NFTABLES_CONF} has ${begins.length} BEGIN and ${ends.length} END agent-interface markers${order}. Fix them by hand to zero or one ordered pair; nothing was changed.`,
  );
}

export function markerProblem(conf) {
  try {
    markerSpan(conf);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function withoutInclude(conf) {
  const span = markerSpan(conf);
  if (span === null) return `${conf.replace(/\n+$/, "")}\n`;
  const lines = conf.split(/\n/);
  const head = lines.slice(0, span[0]).join("\n").replace(/\n+$/, "");
  const tail = lines
    .slice(span[1] + 1)
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  return `${[head, tail].filter(Boolean).join("\n\n")}\n`;
}

export function withInclude(conf) {
  const block =
    `${BEGIN_LINE}\n` +
    "# Keep this block last, after any flush ruleset.\n" +
    `include "${RULES}"\n${END}\n`;
  return `${withoutInclude(conf)}\n${block}`;
}

export function installedUid(text) {
  const matches = [...(text ?? "").matchAll(/meta skuid (\d+) /g)].map((m) => Number(m[1]));
  const unique = new Set(matches);
  return unique.size === 1 ? [...unique][0] : null;
}

export function resolveUser({ user = null, uid = null } = {}) {
  const arg = user !== null ? user : String(uid);
  const res = spawnSync("getent", ["passwd", arg], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(`No account ${arg} exists on this host.`);
  }
  const [name, , uidStr, gidStr] = res.stdout.trim().split(":");
  const resolvedUid = Number(uidStr);
  const resolvedGid = Number(gidStr);
  if (resolvedUid === 0) {
    throw new Error("Refusing uid 0: blocking root would break cloud-init and protect nothing.");
  }
  return { name, uid: resolvedUid, gid: resolvedGid };
}

export function verdict(attempt) {
  if (attempt.outcome === "connected") return "connected";
  if (REFUSALS.has(attempt.outcome) && attempt.ms <= REFUSED_WITHIN_MS) return "refused";
  if (NO_ROUTE.has(attempt.outcome)) return "no-route";
  return "inconclusive";
}

export function probeProblems(probeResult) {
  const problems = [];
  const v4 = verdict(probeResult.metadataV4);
  if (v4 !== "refused") {
    problems.push(
      `${METADATA_V4}:80 was ${v4} (${probeResult.metadataV4.outcome} in ${probeResult.metadataV4.ms} ms), not refused.`,
    );
  }
  for (const iface of Object.keys(probeResult.metadataV6).sort()) {
    const attempt = probeResult.metadataV6[iface];
    const found = verdict(attempt);
    if (found !== "refused" && found !== "no-route") {
      problems.push(
        `${METADATA_V6}%${iface} port 80 was ${found} (${attempt.outcome} in ${attempt.ms} ms), not refused.`,
      );
    }
  }
  return problems;
}

export function requiresFloor(show) {
  const props = {};
  for (const line of show.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq >= 0) props[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return ["Requires", "After"].every((key) => (props[key] ?? "").split(/\s+/).includes(UNIT));
}

function normalizedRule(rule, user) {
  let uid = null,
    family = null,
    address = null,
    l4 = null,
    action = null;
  const extra = [];
  for (const expression of rule.expr ?? []) {
    if ("match" in expression) {
      const match = expression.match;
      const left = match.left ?? {};
      const right = match.right;
      const op = match.op ?? "==";
      if (op !== "==" && op !== "in") {
        extra.push(JSON.stringify(expression));
      } else if (left.meta?.key === "skuid") {
        uid = /^\d+$/.test(String(right)) ? Number(right) : right === user[0] ? user[1] : right;
      } else if (left.meta?.key === "l4proto") {
        l4 = right === "tcp" || right === 6 ? "tcp" : right;
      } else if (left.meta?.key === "nfproto") {
        continue;
      } else if (left.payload?.field === "daddr") {
        family = left.payload.protocol;
        address = right;
      } else {
        extra.push(JSON.stringify(expression));
      }
    } else if ("reject" in expression) {
      const reject = expression.reject ?? {};
      action = [reject.type, reject.expr].filter(Boolean).map(String).join(" ");
    } else {
      extra.push(JSON.stringify(expression));
    }
  }
  return extra.length ? ["unexpected", ...extra] : [uid, family, address, l4, action];
}

export function liveRuleProblems(listing, uid, user) {
  let items;
  try {
    items = JSON.parse(listing).nftables;
    if (!Array.isArray(items)) throw new Error("not array");
  } catch {
    return ["The live table could not be listed as nft JSON."];
  }
  const chains = items.filter((item) => "chain" in item).map((item) => item.chain);
  const shape = chains.map((chain) => [
    chain.name ?? null,
    chain.type ?? null,
    chain.hook ?? null,
    chain.prio ?? 0,
    chain.policy ?? "accept",
  ]);
  const problems = [];
  if (JSON.stringify(shape) !== JSON.stringify([["output", "filter", "output", 0, "accept"]])) {
    problems.push(
      `The live table's chains are ${JSON.stringify(shape)}, not one filter chain on the output hook.`,
    );
  }
  const live = items
    .filter((item) => "rule" in item)
    .map((item) => normalizedRule(item.rule, [user, uid]))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const expected = expectedRules(uid);
  if (JSON.stringify(live) !== JSON.stringify(expected)) {
    problems.push(`The live rules are ${JSON.stringify(live)}, not ${JSON.stringify(expected)}.`);
  }
  return problems;
}

const PROBE_SCRIPT = `
const dns = require("node:dns/promises");
const fs = require("node:fs");
const net = require("node:net");

function attempt(host, port, timeoutMs) {
  const started = performance.now();
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ outcome, ms: Math.round(performance.now() - started) });
    };
    sock.setTimeout(timeoutMs, () => finish("timeout"));
    sock.once("connect", () => finish("connected"));
    sock.once("error", (err) => finish(err.code || "error"));
  });
}

function linkLocalInterfaces(path) {
  try {
    const rows = fs.readFileSync(path, "utf8").split(/\\r?\\n/).map((l) => l.trim().split(/\\s+/));
    return [...new Set(rows.filter((r) => r.length === 6 && r[3] === "20" && r[5] !== "lo").map((r) => r[5]))].sort();
  } catch {
    return [];
  }
}

(async () => {
  const args = JSON.parse(process.argv[1]);
  const metadataV4 = await attempt(args.v4, args.port, args.timeout * 1000);
  const metadataV6 = {};
  for (const name of linkLocalInterfaces(args.interfaces)) {
    metadataV6[name] = await attempt(args.v6 + "%" + name, args.port, args.timeout * 1000);
  }
  const [host, port] = args.egress;
  let dnsResult;
  try {
    const addrs = await dns.lookup(host, { all: true });
    dnsResult = { outcome: "resolved", addresses: [...new Set(addrs.map((a) => a.address))].sort() };
  } catch (err) {
    dnsResult = { outcome: "failed", error: String(err) };
  }
  const egress = await attempt(host, port, 10000);
  console.log(JSON.stringify({ metadataV4, metadataV6, dns: dnsResult, egress }));
})();
`;

export class System {
  constructor(root = "/") {
    this.root = root;
  }
  path(absolute) {
    return join(this.root, absolute.replace(/^\/+/, ""));
  }
  run(argv, { input, timeout = 60000 } = {}) {
    const res = spawnSync(argv[0], argv.slice(1), {
      input,
      encoding: "utf8",
      timeout,
    });
    return {
      returncode: res.status ?? 1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  }
  nft() {
    const found = spawnSync("which", ["nft"], { encoding: "utf8" });
    return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : "/usr/sbin/nft";
  }
  read(absolute) {
    const p = this.path(absolute);
    return existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf8") : null;
  }
  write(absolute, text, fileMode = 0o644) {
    const p = this.path(absolute);
    if (existsSync(p) && statSync(p).isFile()) {
      if (readFileSync(p, "utf8") === text && (statSync(p).mode & 0o777) === fileMode) {
        return false;
      }
    }
    mkdirSync(dirname(p), { recursive: true });
    const staged = `${p}.new`;
    writeFileSync(staged, text, "utf8");
    chmodSync(staged, fileMode);
    renameSync(staged, p);
    return true;
  }
  remove(absolute) {
    const p = this.path(absolute);
    if (existsSync(p) && statSync(p).isFile()) {
      rmSync(p);
      return true;
    }
    return false;
  }
  requireRoot() {
    if (typeof process.geteuid === "function" && process.geteuid() !== 0) {
      throw new Error("Run this with sudo: it loads nftables rules and root systemd units.");
    }
  }
}

function must(system, argv, why) {
  const done = system.run(argv);
  if (done.returncode !== 0) {
    const detail = (done.stderr || done.stdout).trim().slice(-500);
    throw new Error(`${why} failed (${argv.join(" ")}): ${detail}`);
  }
  return done;
}

function validated(system, filePath, text, argv, why) {
  const staged = `${filePath}.check`;
  system.write(staged, text, 0o600);
  try {
    must(system, [...argv, staged], why);
  } finally {
    system.remove(staged);
  }
}

export function mode(system) {
  const service =
    system.run(["systemctl", "is-enabled", "nftables.service"]).stdout.trim() || "not-found";
  const conf = system.read(NFTABLES_CONF);
  const included = conf !== null && !markerProblem(conf) && withInclude(conf) === conf;
  return {
    nftablesService: service,
    nftablesConfInclude: included,
    persistence: included ? "nftables.conf include and boot unit" : "boot unit only",
  };
}

function requireMarkers(system) {
  const conf = system.read(NFTABLES_CONF);
  if (conf !== null && markerProblem(conf)) throw new Error(markerProblem(conf));
  return conf;
}

export function managedUserDropins(system) {
  const dir = system.path(SYSTEMD);
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (!/^user@\d+\.service\.d$/.test(entry)) continue;
    const full = join(dir, entry, DROPIN_NAME);
    if (existsSync(full) && statSync(full).isFile()) {
      found.push(`${SYSTEMD}/${entry}/${DROPIN_NAME}`);
    }
  }
  return found.sort();
}

export function install(system, name, uid) {
  system.requireRoot();
  const nft = system.nft();
  requireMarkers(system);
  const script = rules(uid);
  const previous = installedUid(system.read(RULES));
  validated(system, RULES, script, [nft, "-c", "-f"], "Checking the generated rules");
  const changed = system.write(RULES, script) ? [RULES] : [];
  const conf = system.read(NFTABLES_CONF);
  if (
    conf === null &&
    system.run(["systemctl", "is-enabled", "nftables.service"]).stdout.trim() === "enabled"
  ) {
    throw new Error(
      `nftables.service is enabled but ${NFTABLES_CONF} is missing; resolve that first.`,
    );
  }
  if (conf !== null && withInclude(conf) !== conf) {
    validated(
      system,
      NFTABLES_CONF,
      withInclude(conf),
      [nft, "-c", "-f"],
      `Checking ${NFTABLES_CONF} with the include`,
    );
    if (system.read(CONF_BACKUP) === null) system.write(CONF_BACKUP, conf);
    const confMode = statSync(system.path(NFTABLES_CONF)).mode & 0o777;
    system.write(NFTABLES_CONF, withInclude(conf), confMode);
    changed.push(NFTABLES_CONF);
  }
  validated(system, SUDOERS, sudoers(name, nft), ["visudo", "-c", "-f"], "Checking the sudo rule");
  validated(system, STOP_FILE, stopRules(), [nft, "-c", "-f"], "Checking the nftables stop file");
  if (system.write(STOP_FILE, stopRules())) changed.push(STOP_FILE);
  const units = [
    [UNIT_FILE, unit(nft)],
    [dropin(uid), userDropin()],
    [NFTABLES_DROPIN, nftablesDropin(nft)],
  ];
  const changedUnits = units.filter(([p, text]) => system.write(p, text)).map(([p]) => p);
  for (const p of managedUserDropins(system)) {
    if (p !== dropin(uid) && system.remove(p)) changedUnits.push(p);
  }
  changed.push(...changedUnits);
  if (system.write(SUDOERS, sudoers(name, nft), 0o440)) changed.push(SUDOERS);
  if (changedUnits.length) {
    must(system, ["systemctl", "daemon-reload"], "Reloading systemd");
  }
  must(system, ["systemctl", "enable", UNIT], "Enabling the boot unit");
  must(system, ["systemctl", "start", UNIT], "Starting the boot unit");
  must(system, ["systemctl", "reload", UNIT], "Loading the table");
  return {
    installed: true,
    uid,
    previousUid: previous,
    changedFiles: changed,
    mode: mode(system),
  };
}

export function remove(system) {
  system.requireRoot();
  const nft = system.nft();
  const conf = requireMarkers(system);
  const removed = [...managedUserDropins(system), NFTABLES_DROPIN].filter((p) => system.remove(p));
  if (removed.length) {
    must(system, ["systemctl", "daemon-reload"], "Reloading systemd");
  }
  if (system.read(UNIT_FILE) !== null) {
    must(system, ["systemctl", "disable", UNIT], "Disabling the boot unit");
  }
  if (conf !== null && withoutInclude(conf) !== conf) {
    validated(
      system,
      NFTABLES_CONF,
      withoutInclude(conf),
      [nft, "-c", "-f"],
      `Checking ${NFTABLES_CONF} without the include`,
    );
    const confMode = statSync(system.path(NFTABLES_CONF)).mode & 0o777;
    system.write(NFTABLES_CONF, withoutInclude(conf), confMode);
    removed.push(NFTABLES_CONF);
  }
  const present = system.run([nft, "list", "table", "inet", TABLE]).returncode === 0;
  if (present) {
    must(system, [nft, "delete", "table", "inet", TABLE], "Deleting the table");
  }
  for (const p of [UNIT_FILE, SUDOERS, STOP_FILE, RULES]) {
    if (system.remove(p)) removed.push(p);
  }
  if (removed.includes(UNIT_FILE)) {
    must(system, ["systemctl", "daemon-reload"], "Reloading systemd");
  }
  return { removed: true, files: removed, tableDeleted: present };
}

function asUser(uid, gid, argv) {
  return ["setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--init-groups", "--", ...argv];
}

export function probe(system, uid, gid, egress) {
  const idx = egress.lastIndexOf(":");
  const host = egress.slice(0, idx);
  const port = Number(egress.slice(idx + 1));
  const payload = JSON.stringify({
    v4: METADATA_V4,
    v6: METADATA_V6,
    port: 80,
    timeout: 3,
    interfaces: system.path("/proc/net/if_inet6"),
    egress: [host, port],
  });
  const done = system.run(asUser(uid, gid, [process.execPath, "-e", PROBE_SCRIPT, payload]), {
    timeout: 120000,
  });
  if (done.returncode !== 0) {
    throw new Error(`The probe could not run as uid ${uid}: ${done.stderr.trim().slice(-500)}`);
  }
  const lines = done.stdout.trim().split(/\r?\n/);
  const result = JSON.parse(lines[lines.length - 1]);
  result.passwordlessSudo = system.run(asUser(uid, gid, ["sudo", "-n", "true"])).returncode === 0;
  return result;
}

export function evaluate(state) {
  const { uid, user: name, mode: found } = state;
  const mustInclude = found.nftablesService === "enabled" || state.confExists;
  const expectedFiles = {
    [RULES]: rules(uid),
    [UNIT_FILE]: unit(state.nft),
    [dropin(uid)]: userDropin(),
    [NFTABLES_DROPIN]: nftablesDropin(state.nft),
    [STOP_FILE]: stopRules(),
    [SUDOERS]: sudoers(name, state.nft),
  };
  const filesCurrent =
    Object.keys(expectedFiles).length === Object.keys(state.files).length &&
    Object.entries(expectedFiles).every(([k, v]) => state.files[k] === v);
  return {
    filesCurrent,
    nftablesConfIncludesFloor: found.nftablesConfInclude || !mustInclude,
    unitEnabled: state.enabled === "enabled",
    unitActive: state.active === "active",
    userManagerRequiresFloor: requiresFloor(state.userManager),
    liveRulesMatch: liveRuleProblems(state.listing, uid, name).length === 0,
    metadataRefused: probeProblems(state.probe).length === 0,
    dnsResolves: state.probe.dns.outcome === "resolved",
    egressConnects: state.probe.egress.outcome === "connected",
  };
}

export function check(system, user = null, egress = DEFAULT_EGRESS) {
  system.requireRoot();
  const nft = system.nft();
  const uid = installedUid(system.read(RULES));
  if (uid === null) {
    throw new Error(
      `The floor is not installed: ${RULES} is missing or not this tool's. Run install first.`,
    );
  }
  const resolved = user ? resolveUser({ user }) : resolveUser({ uid });
  if (resolved.uid !== uid) {
    throw new Error(
      `The floor blocks uid ${uid}, but ${resolved.name} is uid ${resolved.uid}. Reinstall with --user ${resolved.name}.`,
    );
  }
  const listing = system.run([nft, "-j", "list", "table", "inet", TABLE]);
  const state = {
    uid,
    user: resolved.name,
    nft,
    mode: mode(system),
    confExists: system.read(NFTABLES_CONF) !== null,
    files: Object.fromEntries(
      [RULES, UNIT_FILE, dropin(uid), NFTABLES_DROPIN, STOP_FILE, SUDOERS].map((p) => [
        p,
        system.read(p),
      ]),
    ),
    enabled: system.run(["systemctl", "is-enabled", UNIT]).stdout.trim(),
    active: system.run(["systemctl", "is-active", UNIT]).stdout.trim(),
    userManager: system.run([
      "systemctl",
      "show",
      userManager(uid),
      "-p",
      "Requires",
      "-p",
      "After",
    ]).stdout,
    listing: listing.returncode === 0 ? listing.stdout : null,
    probe: probe(system, uid, resolved.gid, egress),
  };
  const checks = evaluate(state);
  const details = [
    ...liveRuleProblems(state.listing, uid, resolved.name),
    ...probeProblems(state.probe),
  ];
  const warnings = [];
  if (state.probe.passwordlessSudo) {
    warnings.push(
      `${resolved.name} can run sudo without a password, so any agent running as ${resolved.name} could remove this floor.`,
    );
  }
  return {
    ok: Object.values(checks).every(Boolean),
    user: resolved.name,
    uid,
    mode: state.mode,
    checks,
    problems: details,
    probe: state.probe,
    warnings,
  };
}

export function main(argv = process.argv.slice(2), system = new System()) {
  const [command, ...rest] = argv;
  if (!command || !["install", "check", "remove"].includes(command)) {
    throw new Error("Usage: metadata-egress-floor.mjs install|check|remove [options]");
  }
  let user = null;
  let uid = null;
  let egress = DEFAULT_EGRESS;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--user") user = rest[++i];
    else if (arg === "--uid") uid = Number(rest[++i]);
    else if (arg === "--egress") egress = rest[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  let result;
  if (command === "install") {
    if ((user === null) === (uid === null)) {
      throw new Error("install requires exactly one of --user or --uid");
    }
    const resolved = user !== null ? resolveUser({ user }) : resolveUser({ uid });
    result = install(system, resolved.name, resolved.uid);
  } else if (command === "check") {
    if (!/^[^\s:]+:\d+$/.test(egress)) throw new Error("--egress must be HOST:PORT");
    result = check(system, user, egress);
  } else {
    result = remove(system);
  }
  console.log(JSON.stringify(result, null, 2));
  for (const warning of result.warnings ?? []) {
    console.error(`Warning: ${warning}`);
  }
  return result.ok === false ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
