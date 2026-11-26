import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { loadConfig, loopback, parseAppOrigin } from "../src/server/config.js";
import type { RuntimeStatus } from "../src/shared/types.js";

const settingKeys = [
  "NODE_ENV",
  "HOST",
  "PORT",
  "APP_ORIGIN",
  "APP_DATABASE",
  "LOCAL_DEV_AUTH",
  "GOOGLE_CLIENT_ID",
  "HOUSEHOLD_EMAILS",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
];
export type EnvValues = Record<string, string>;
export function effectiveEnv(text: string, exported: NodeJS.ProcessEnv = process.env) {
  const values = parseEnv(text);
  const shadowed = settingKeys.filter((key) => key in values && exported[key] !== undefined);
  return {
    values: {
      ...values,
      ...Object.fromEntries(Object.entries(exported).filter(([, value]) => value !== undefined)),
    } as EnvValues,
    shadowed,
  };
}

export async function resolveSetupOrigin(
  values: NodeJS.ProcessEnv,
  requestOrigin: (label: string) => Promise<string> = ask,
): Promise<{ origin: URL; correction?: string }> {
  const existing = values.APP_ORIGIN ?? `http://127.0.0.1:${values.PORT ?? 3000}`;
  try {
    return { origin: parseAppOrigin(existing) };
  } catch {
    // An invalid saved public address must never silently become a local address.
    const correction = await requestOrigin(
      "APP_ORIGIN is invalid. Enter the application origin used by the browser, including http:// or https://",
    );
    return { origin: parseAppOrigin(correction), correction };
  }
}

// Preserve untouched comments and assignments, including multiline quoted values.
export function updateEnv(text: string, changes: EnvValues): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const output: string[] = [];
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\r\n]*)/);
    let span = line;
    if (match && ['"', "'", "`"].includes(match[2][0])) {
      const quote = match[2][0];
      let value = match[2].slice(1);
      while (!value.includes(quote) && i + 1 < lines.length) {
        const continuation = lines[++i];
        span += continuation;
        value += continuation;
      }
    }
    if (!match || !(match[1] in changes)) output.push(span);
  }
  let result = output.join("");
  if (result && !result.endsWith("\n")) result += newline;
  for (const [key, value] of Object.entries(changes)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value))
      throw new Error("Settings must contain one line per value.");
    const quote = ['"', "'", "`"].find(
      (character) =>
        !value.includes(character) &&
        parseEnv(`${key}=${character}${value}${character}`)[key] === value,
    );
    if (!quote) throw new Error("A setting contains unsupported quote characters.");
    result += `${key}=${quote}${value}${quote}${newline}`;
  }
  // Node's parser is the authority. Never save a value whose roundtrip changed.
  const parsed = parseEnv(result);
  if (Object.entries(changes).some(([key, value]) => parsed[key] !== value))
    throw new Error("A setting cannot be represented safely in the environment file.");
  return result;
}

export async function readPrivateEnv(filename: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("The environment file must be a regular file, not a symbolic link.");
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function savePrivateEnv(
  filename: string,
  original: string | undefined,
  next: string,
): Promise<void> {
  if ((await readPrivateEnv(filename)) !== original)
    throw new Error(
      "The environment file changed during setup. Run setup again to keep those changes.",
    );
  const temporary = path.join(path.dirname(filename), `.agent-interface-env-${randomUUID()}`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(next, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await readPrivateEnv(filename)) !== original)
      throw new Error(
        "The environment file changed during setup. Run setup again to keep those changes.",
      );
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function checkSetup(values: NodeJS.ProcessEnv): Promise<RuntimeStatus> {
  const config = loadConfig(values);
  if (!config.localDevAuth && (!config.googleClientId || !config.householdEmails.length))
    throw new Error(
      "Configure Google sign-in and HOUSEHOLD_EMAILS, or explicitly select local test sign-in on a loopback development installation.",
    );
  return { connected: true, code: "ready", detail: "Configuration is valid." };
}

export async function verifyAndSave(
  filename: string,
  original: string | undefined,
  next: string,
  exported: NodeJS.ProcessEnv = process.env,
) {
  const status = await checkSetup(effectiveEnv(next, exported).values);
  await savePrivateEnv(filename, original, next);
  return status;
}

function ask(label: string, fallback = ""): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    let answered = false;
    terminal.on("close", () => {
      if (!answered) reject(new Error("Setup cancelled. No settings were saved."));
    });
    terminal.on("SIGINT", () => terminal.close());
    terminal.question(`${label}${fallback ? ` [${fallback}]` : ""}: `, (answer) => {
      answered = true;
      terminal.close();
      resolve(answer.trim() || fallback);
    });
  });
}

async function main() {
  const doctor = process.argv.slice(2).includes("--check");
  if (process.argv.slice(2).some((argument) => argument !== "--check"))
    throw new Error("Use pnpm run setup or pnpm run doctor.");
  const filename = path.resolve(".env");
  const original = await readPrivateEnv(filename);
  const source = original ?? (await fs.readFile(".env.example", "utf8"));
  const current = effectiveEnv(source);
  if (current.shadowed.length)
    console.log(
      `Exported environment settings override the file: ${current.shadowed.join(", ")}. Values are not displayed.`,
    );
  if (doctor) {
    const status = await checkSetup(current.values);
    console.log(`WildBots: ${status.code ?? "ready"}. ${status.detail ?? ""}`);
    process.exitCode = status.connected ? 0 : 1;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Setup needs an interactive terminal. Run pnpm run setup in a terminal, or use pnpm run doctor to check existing settings.",
    );
  const values = current.values;
  const changes: EnvValues = {};
  const { origin: publicOrigin, correction } = await resolveSetupOrigin(values);
  if (correction !== undefined) changes.APP_ORIGIN = correction;
  const production =
    values.NODE_ENV === "production" ||
    !loopback(values.HOST || "127.0.0.1") ||
    !loopback(publicOrigin.hostname);
  let mode = "google";
  if (!production) {
    mode = await ask(
      "Sign-in: google or local test",
      values.LOCAL_DEV_AUTH === "true" ? "local" : "google",
    );
    if (!["google", "local"].includes(mode))
      throw new Error("Choose google or local. No settings were saved.");
  } else
    console.log(
      "This installation requires Google sign-in. Production mode and binding are preserved.",
    );
  changes.LOCAL_DEV_AUTH = mode === "local" ? "true" : "false";
  if (mode === "google") {
    changes.APP_ORIGIN ??= await ask(
      "Application origin used by the browser",
      values.APP_ORIGIN || publicOrigin.origin,
    );
    changes.GOOGLE_CLIENT_ID = await ask("Google OAuth web client ID", values.GOOGLE_CLIENT_ID);
    changes.HOUSEHOLD_EMAILS = await ask(
      "Allowed household emails, comma-separated",
      values.HOUSEHOLD_EMAILS,
    );
  }
  const conflict = Object.keys(changes).filter(
    (key) => process.env[key] !== undefined && process.env[key] !== changes[key],
  );
  if (conflict.length)
    throw new Error(
      `Unset conflicting exported settings before saving: ${conflict.join(", ")}. No settings were saved.`,
    );
  const next = updateEnv(source, changes);
  await verifyAndSave(filename, original, next);
  console.log(
    "Verified settings saved to .env with owner-only permissions. Run pnpm run build, then pnpm start.",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Setup failed. No settings were saved.");
    process.exitCode = 1;
  });
}
