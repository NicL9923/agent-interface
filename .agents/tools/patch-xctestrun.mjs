#!/usr/bin/env node
/**
 * Copy an .xctestrun so its UI test targets wait only briefly for crash reports.
 *
 * Usage: patch-xctestrun.mjs SOURCE.xctestrun DESTINATION.xctestrun SECONDS
 *
 * XCTest waits for crash reports after every UI test. On the Mac mini that wait reached about
 * 300 seconds per test. The copy sets XCTCrashReportCollectionTimeout for every UI test target,
 * both as a launch argument and in the environment. The copy must sit beside the original,
 * because an .xctestrun locates the built products relative to its own directory.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SETTING = "XCTCrashReportCollectionTimeout";

function unescapeXml(text) {
  return text.replace(/&(lt|gt|amp|apos|quot);/g, (_, name) => {
    switch (name) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "apos":
        return "'";
      case "quot":
        return '"';
      default:
        return `&${name};`;
    }
  });
}

function escapeXml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Parse an Apple XML plist into plain JS values (dict, array, string, integer, real, true, false, data, date). */
export function parsePlistXml(xmlText) {
  const tokens = [];
  const re =
    /<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->|<\/([A-Za-z0-9_-]+)>|<([A-Za-z0-9_-]+)(?:\s[^>]*)?(\/?)>|([^<]+)/g;
  let match;
  while ((match = re.exec(xmlText)) !== null) {
    if (match[1]) tokens.push({ type: "close", tag: match[1] });
    else if (match[2]) tokens.push({ type: match[3] ? "self" : "open", tag: match[2] });
    else if (match[4] !== undefined) tokens.push({ type: "text", value: match[4] });
  }

  let index = 0;
  function skipWs() {
    while (index < tokens.length && tokens[index].type === "text" && !tokens[index].value.trim()) {
      index++;
    }
  }

  function readText(tag) {
    let out = "";
    while (index < tokens.length) {
      const tok = tokens[index++];
      if (tok.type === "close" && tok.tag === tag) return unescapeXml(out);
      if (tok.type === "text") out += tok.value;
    }
    throw new Error(`Unclosed <${tag}> in plist`);
  }

  function parseValue() {
    skipWs();
    if (index >= tokens.length) throw new Error("Unexpected end of plist");
    const tok = tokens[index++];
    if (tok.type === "self") {
      if (tok.tag === "true") return true;
      if (tok.tag === "false") return false;
      if (tok.tag === "dict") return {};
      if (tok.tag === "array") return [];
      if (tok.tag === "string") return "";
      throw new Error(`Unsupported self-closing plist tag <${tok.tag}/>`);
    }
    if (tok.type !== "open") throw new Error(`Unexpected plist token: ${JSON.stringify(tok)}`);
    switch (tok.tag) {
      case "plist": {
        const inner = parseValue();
        skipWs();
        if (tokens[index]?.type === "close" && tokens[index].tag === "plist") index++;
        return inner;
      }
      case "string":
        return readText("string");
      case "integer":
        return Number.parseInt(readText("integer").trim(), 10);
      case "real":
        return Number.parseFloat(readText("real").trim());
      case "date":
        return { __plistType: "date", value: readText("date").trim() };
      case "data":
        return { __plistType: "data", value: readText("data").trim() };
      case "array": {
        const items = [];
        while (true) {
          skipWs();
          if (tokens[index]?.type === "close" && tokens[index].tag === "array") {
            index++;
            return items;
          }
          items.push(parseValue());
        }
      }
      case "dict": {
        const obj = {};
        while (true) {
          skipWs();
          if (tokens[index]?.type === "close" && tokens[index].tag === "dict") {
            index++;
            return obj;
          }
          const keyTok = tokens[index++];
          if (keyTok?.type !== "open" || keyTok.tag !== "key") {
            throw new Error(`Expected <key> in plist dict, got ${JSON.stringify(keyTok)}`);
          }
          const key = readText("key");
          obj[key] = parseValue();
        }
      }
      default:
        throw new Error(`Unsupported plist tag <${tok.tag}>`);
    }
  }

  return parseValue();
}

function serializeValue(value, indent = "") {
  if (value === true) return `${indent}<true/>`;
  if (value === false) return `${indent}<false/>`;
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `${indent}<integer>${value}</integer>`
      : `${indent}<real>${value}</real>`;
  }
  if (typeof value === "string") {
    return `${indent}<string>${escapeXml(value)}</string>`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}<array/>`;
    const body = value.map((item) => serializeValue(item, `${indent}\t`)).join("\n");
    return `${indent}<array>\n${body}\n${indent}</array>`;
  }
  if (value && typeof value === "object") {
    if (value.__plistType === "date") return `${indent}<date>${escapeXml(value.value)}</date>`;
    if (value.__plistType === "data") return `${indent}<data>${escapeXml(value.value)}</data>`;
    const entries = Object.entries(value);
    if (!entries.length) return `${indent}<dict/>`;
    const body = entries
      .map(
        ([key, item]) =>
          `${indent}\t<key>${escapeXml(key)}</key>\n${serializeValue(item, `${indent}\t`)}`,
      )
      .join("\n");
    return `${indent}<dict>\n${body}\n${indent}</dict>`;
  }
  throw new Error(`Cannot serialize plist value: ${typeof value}`);
}

export function serializePlistXml(value) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    `${serializeValue(value)}\n` +
    "</plist>\n"
  );
}

export function loadPlist(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.subarray(0, 6).toString("ascii") === "bplist") {
    const xml = execFileSync("plutil", ["-convert", "xml1", "-o", "-", filePath], {
      encoding: "utf8",
    });
    return parsePlistXml(xml);
  }
  return parsePlistXml(bytes.toString("utf8"));
}

export function testTargets(run) {
  const version = run?.__xctestrun_metadata__?.FormatVersion ?? 1;
  if (version === 1) {
    return Object.entries(run)
      .filter(
        ([key, value]) =>
          !key.startsWith("__") && value && typeof value === "object" && !Array.isArray(value),
      )
      .map(([, value]) => value);
  }
  if (version === 2) {
    const out = [];
    for (const configuration of run.TestConfigurations ?? []) {
      for (const target of configuration.TestTargets ?? []) out.push(target);
    }
    return out;
  }
  throw new Error(`Unsupported xctestrun FormatVersion ${version}.`);
}

export function patch(run, seconds) {
  const targets = testTargets(run).filter((target) => target.IsUITestBundle);
  if (!targets.length) {
    throw new Error("The xctestrun has no UI test target to patch.");
  }
  const flag = `-${SETTING}`;
  for (const target of targets) {
    const args = Array.isArray(target.CommandLineArguments) ? target.CommandLineArguments : [];
    // Drop an earlier value so repeated patching keeps one setting.
    const kept = [];
    let skip = false;
    for (const argument of args) {
      if (skip) skip = false;
      else if (argument === flag) skip = true;
      else kept.push(argument);
    }
    target.CommandLineArguments = [...kept, flag, String(seconds)];
    if (!target.EnvironmentVariables || typeof target.EnvironmentVariables !== "object") {
      target.EnvironmentVariables = {};
    }
    target.EnvironmentVariables[SETTING] = String(seconds);
  }
  return targets.map((target) => target.BlueprintName ?? "?");
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    throw new Error("Usage: patch-xctestrun.mjs SOURCE.xctestrun DESTINATION.xctestrun SECONDS");
  }
  const [sourceArg, destinationArg, secondsArg] = argv;
  const source = resolve(sourceArg);
  const destination = resolve(destinationArg);
  const seconds = Number(secondsArg);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("SECONDS must be positive.");
  }
  if (dirname(source) !== dirname(destination) || source === destination) {
    throw new Error("Write the copy beside the original, under a different name.");
  }
  const run = loadPlist(source);
  const names = patch(run, seconds);
  writeFileSync(destination, serializePlistXml(run), "utf8");
  console.log(`${SETTING}=${seconds} for ${names.join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
