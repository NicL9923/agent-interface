#!/usr/bin/env node
/** Archive public server/build inputs without ignored secrets or macOS metadata. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

function writeOctal(buf, offset, length, value) {
  const str = value.toString(8).padStart(length - 1, "0");
  buf.write(str.slice(-(length - 1)), offset, length - 1, "ascii");
  buf[offset + length - 1] = 0;
}

function makeTarHeader(name, size, mode, mtime, typeflag = "0") {
  const header = Buffer.alloc(512, 0);
  let fileName = name;
  let prefix = "";
  if (Buffer.byteLength(name, "utf8") > 100) {
    const slash = name.lastIndexOf("/");
    if (
      slash > 0 &&
      Buffer.byteLength(name.slice(0, slash), "utf8") <= 155 &&
      Buffer.byteLength(name.slice(slash + 1), "utf8") <= 100
    ) {
      prefix = name.slice(0, slash);
      fileName = name.slice(slash + 1);
    } else {
      fileName = name.slice(-100);
    }
  }
  header.write(fileName, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode & 0o777);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(mtime));
  header.fill(0x20, 148, 156); // checksum placeholder
  header.write(typeflag, 156, 1, "ascii");
  header.write("ustar", 257, 5, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const chksum = sum.toString(8).padStart(6, "0");
  header.write(chksum, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function makePaxRecords(records) {
  const parts = [];
  for (const [key, val] of Object.entries(records)) {
    const body = ` ${key}=${val}\n`;
    let len = Buffer.byteLength(body, "utf8") + 1;
    while (true) {
      const line = `${len}${body}`;
      const byteLen = Buffer.byteLength(line, "utf8");
      if (byteLen === len) {
        parts.push(Buffer.from(line, "utf8"));
        break;
      }
      len = byteLen;
    }
  }
  return Buffer.concat(parts);
}

function pad512(buf) {
  const rem = buf.length % 512;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem, 0)]);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
if (process.argv.length !== 3) {
  console.error("Usage: node .agents/tools/archive-release.mjs OUTPUT.tar.gz");
  process.exit(1);
}
const output = resolve(process.argv[2]);
const names = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
).split("\0");

const top = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "tsconfig.json",
  ".node-version",
  ".env.example",
]);
const dirs = ["src/", "scripts/", "tests/", "public/", ".agents/tools/"];

// The host build type-checks everything tsconfig.json includes, so each of those paths ships
// without editing this list. A directory added there and left out here broke the host build twice.
const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
for (const entry of tsconfig.include ?? []) {
  try {
    if (statSync(join(root, entry)).isDirectory()) {
      dirs.push(`${entry.replace(/\/+$/, "")}/`);
    } else {
      top.add(entry);
    }
  } catch {
    top.add(entry);
  }
}

// Every top-level HTML file is a Vite entry, so a new entry ships without editing this list.
const files = [
  ...new Set(
    names.filter(
      (name) =>
        name &&
        (top.has(name) ||
          (!name.includes("/") && name.endsWith(".html")) ||
          dirs.some((dir) => name.startsWith(dir))),
    ),
  ),
].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const chunks = [];
for (const name of files) {
  const full = join(root, name);
  let lst;
  try {
    lst = lstatSync(full);
  } catch {
    continue;
  }
  if (lst.isSymbolicLink()) {
    console.error(`Release inputs must be regular files: ${name}`);
    process.exit(1);
  }
  if (!lst.isFile()) continue;
  const data = readFileSync(full);
  const mtime = lst.mtimeMs / 1000;
  if (Buffer.byteLength(name, "utf8") > 100) {
    const pax = makePaxRecords({ path: name });
    chunks.push(makeTarHeader(`PaxHeader/${name.slice(-80)}`, pax.length, 0o644, mtime, "x"));
    chunks.push(pad512(pax));
  }
  chunks.push(makeTarHeader(name, data.length, lst.mode, mtime, "0"));
  chunks.push(pad512(data));
}
chunks.push(Buffer.alloc(1024, 0));

const gz = gzipSync(Buffer.concat(chunks));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, gz);
console.log(
  JSON.stringify({
    archive: output,
    sha256: createHash("sha256").update(gz).digest("hex"),
    files: files.length,
  }),
);
