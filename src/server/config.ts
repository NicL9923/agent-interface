import { dirname, join } from "node:path";
import type { DirectRouteKind } from "../shared/api.js";
import { NATIVE_HARNESS_KINDS, type NativeHarnessKind } from "../shared/harness.js";
export interface HarnessFallbackConfig {
  harness: NativeHarnessKind;
  model: string;
  provider: string;
  credentialId?: string;
}
export interface DirectRoutesConfig {
  kinds: DirectRouteKind[];
  port: number;
  /** Holds the listeners' private key and certificate. Owner-private. */
  stateDirectory: string;
}
export interface Config {
  production: boolean;
  host: string;
  port: number;
  origin: string;
  database: string;
  localDevAuth: boolean;
  googleClientId: string;
  householdEmails: string[];
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  /** Unset in embedded and test servers, which stay silent; the entrypoint defaults to info. */
  logLevel?: LogLevel;
  backupDirectory?: string;
  integrationAdmins?: string[];
  computerTerminalAdmins?: string[];
  computerTerminal?: { stateDirectory: string; cwd: string; python: string };
  /** Optional LAN and tailnet listeners the iOS app prefers when it can reach them. */
  directRoutes?: DirectRoutesConfig;
  /** Shared secret authenticating Mac link relay requests. Unset turns Mac links off. */
  macLinkKey?: string;
  /**
   * Native agent harnesses (Antigravity, Codex, Claude Code, Grok, Pi) with their workspaces and uploads under
   * `workspaceRoot`. Present whenever the database is on disk or `WILDBOTS_WORKSPACE_ROOT` is set.
   */
  nativeHarness?: { workspaceRoot: string; fallback?: HarnessFallbackConfig };
  /** The newest distributed iOS build and where to get it, for the app's update banner. */
  nativeApp?: { latestBuild: number; updateUrl: string };
  apns?: {
    teamId: string;
    keyId: string;
    topic: string;
    privateKeyFile: string;
    environment: "sandbox" | "production";
  };
}
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof logLevels)[number];
export const loopback = (host: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
export function parseAppOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("APP_ORIGIN must be a valid HTTP or HTTPS origin, including its protocol");
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== value)
    throw new Error("APP_ORIGIN must be an HTTP or HTTPS origin with no trailing slash or path");
  return origin;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    production: env.NODE_ENV === "production",
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 3000),
    origin: env.APP_ORIGIN ?? `http://127.0.0.1:${env.PORT ?? 3000}`,
    database: env.APP_DATABASE ?? "./data/app.sqlite",
    localDevAuth: env.LOCAL_DEV_AUTH === "true",
    googleClientId: env.GOOGLE_CLIENT_ID ?? "",
    householdEmails: (env.HOUSEHOLD_EMAILS ?? "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? "",
    vapidPrivateKey: env.VAPID_PRIVATE_KEY ?? "",
    vapidSubject: env.VAPID_SUBJECT ?? "",
    logLevel: (env.LOG_LEVEL || undefined) as LogLevel | undefined,
    backupDirectory: env.APP_BACKUP_DIR || undefined,
    macLinkKey: env.MAC_LINK_KEY || undefined,
  };
  if (config.logLevel && !logLevels.includes(config.logLevel))
    throw new Error(`LOG_LEVEL must be one of ${logLevels.join(", ")}`);
  const origin = parseAppOrigin(config.origin);
  if (env.COMPUTER_TERMINAL_ENABLED && !["true", "false"].includes(env.COMPUTER_TERMINAL_ENABLED))
    throw new Error("COMPUTER_TERMINAL_ENABLED must be true or false");
  if (env.COMPUTER_TERMINAL_ENABLED === "true") {
    if (
      ![env.COMPUTER_STATE_DIR, env.COMPUTER_TERMINAL_CWD, env.COMPUTER_PYTHON].every(
        (path) => path?.startsWith("/") && !path.includes("\0"),
      )
    )
      throw new Error("The computer terminal requires absolute state, workspace and Python paths");
    config.computerTerminal = {
      stateDirectory: env.COMPUTER_STATE_DIR!,
      cwd: env.COMPUTER_TERMINAL_CWD!,
      python: env.COMPUTER_PYTHON!,
    };
  }
  if (config.macLinkKey !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(config.macLinkKey))
    throw new Error("MAC_LINK_KEY must be a generated 32-byte base64url key");
  config.production = config.production || !loopback(config.host) || !loopback(origin.hostname);
  const rawIntegrationAdmins = env.INTEGRATION_ADMINS ?? env.HERMES_INTEGRATION_ADMINS;
  config.integrationAdmins =
    rawIntegrationAdmins === undefined
      ? []
      : [
          ...new Set(
            rawIntegrationAdmins
              .split(",")
              .map((email) => email.trim().toLowerCase())
              .filter(Boolean),
          ),
        ];
  if (
    config.production &&
    config.integrationAdmins.some((email) => !config.householdEmails.includes(email))
  )
    throw new Error("Integration administrators must belong to the household allowlist");
  config.computerTerminalAdmins =
    env.COMPUTER_TERMINAL_ADMINS === undefined
      ? [...config.integrationAdmins]
      : [
          ...new Set(
            env.COMPUTER_TERMINAL_ADMINS.split(",")
              .map((email) => email.trim().toLowerCase())
              .filter(Boolean),
          ),
        ];
  if (
    config.production &&
    config.computerTerminalAdmins.some((email) => !config.householdEmails.includes(email))
  )
    throw new Error("Terminal administrators must belong to the household allowlist");
  if (
    config.localDevAuth &&
    (config.production || !loopback(config.host) || !loopback(origin.hostname))
  )
    throw new Error(
      "Local development auth requires development mode and a loopback host and origin",
    );
  if (
    config.production &&
    (origin.protocol !== "https:" || !config.googleClientId || !config.householdEmails.length)
  )
    throw new Error(
      "Production requires HTTPS, Google client ID, and an explicit household allowlist",
    );
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error("Invalid port");
  if (
    [config.vapidPublicKey, config.vapidPrivateKey, config.vapidSubject].some(Boolean) &&
    ![config.vapidPublicKey, config.vapidPrivateKey, config.vapidSubject].every(Boolean)
  )
    throw new Error("All VAPID settings must be supplied together");
  const apns = [env.APNS_TEAM_ID, env.APNS_KEY_ID, env.APNS_TOPIC, env.APNS_PRIVATE_KEY_FILE];
  if (apns.some(Boolean)) {
    if (!apns.every(Boolean))
      throw new Error("All APNs signing settings must be supplied together");
    if (!/^[A-Z0-9]{10}$/.test(env.APNS_TEAM_ID!) || !/^[A-Z0-9]{10}$/.test(env.APNS_KEY_ID!))
      throw new Error("APNs team and key IDs must contain 10 uppercase letters or digits");
    if (!/^[A-Za-z0-9.-]{1,255}$/.test(env.APNS_TOPIC!)) throw new Error("Invalid APNs bundle ID");
    if (!["sandbox", "production"].includes(env.APNS_ENVIRONMENT ?? ""))
      throw new Error("APNS_ENVIRONMENT must be sandbox or production when APNs is configured");
    config.apns = {
      teamId: env.APNS_TEAM_ID!,
      keyId: env.APNS_KEY_ID!,
      topic: env.APNS_TOPIC!,
      privateKeyFile: env.APNS_PRIVATE_KEY_FILE!,
      environment: env.APNS_ENVIRONMENT as "sandbox" | "production",
    };
  } else if (env.APNS_ENVIRONMENT)
    throw new Error("APNs signing settings are required with APNS_ENVIRONMENT");
  if (env.DIRECT_ROUTES) {
    const kinds = [
      ...new Set(
        env.DIRECT_ROUTES.split(",")
          .map((kind) => kind.trim())
          .filter(Boolean),
      ),
    ];
    if (!kinds.length || kinds.some((kind) => kind !== "lan" && kind !== "tailnet"))
      throw new Error("DIRECT_ROUTES must list lan, tailnet or both, separated by commas");
    const port = Number(env.DIRECT_PORT || 3443);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("DIRECT_PORT must be a port number");
    if (port === config.port) throw new Error("DIRECT_PORT must differ from PORT");
    const stateDirectory =
      env.DIRECT_TLS_DIR ||
      (config.database === ":memory:" ? "" : join(dirname(config.database), "direct-tls"));
    if (!stateDirectory)
      throw new Error("DIRECT_TLS_DIR is required when APP_DATABASE is in memory");
    config.directRoutes = { kinds: kinds as DirectRoutesConfig["kinds"], port, stateDirectory };
  } else if (env.DIRECT_PORT || env.DIRECT_TLS_DIR)
    throw new Error("DIRECT_PORT and DIRECT_TLS_DIR require DIRECT_ROUTES");
  const workspaceRoot =
    env.WILDBOTS_WORKSPACE_ROOT?.trim() ||
    (config.database === ":memory:" ? undefined : join(dirname(config.database), "harness"));
  if (workspaceRoot) {
    const fallbackDisabled =
      env.WILDBOTS_FALLBACK_ENABLED === "false" ||
      env.WILDBOTS_FALLBACK_MODEL?.trim().toLowerCase() === "off";
    const fallbackRequested =
      !fallbackDisabled &&
      Boolean(env.WILDBOTS_FALLBACK_MODEL?.trim() || env.OPENROUTER_API_KEY?.trim());
    let fallback: HarnessFallbackConfig | undefined;
    if (fallbackRequested) {
      const rawHarness = (env.WILDBOTS_FALLBACK_HARNESS?.trim().toLowerCase() || "pi") as string;
      if (!NATIVE_HARNESS_KINDS.includes(rawHarness as NativeHarnessKind)) {
        throw new Error(
          `WILDBOTS_FALLBACK_HARNESS must be one of ${NATIVE_HARNESS_KINDS.join(", ")}`,
        );
      }
      fallback = {
        harness: rawHarness as NativeHarnessKind,
        model: env.WILDBOTS_FALLBACK_MODEL?.trim() || "deepseek/deepseek-v4.1-flash",
        provider: env.WILDBOTS_FALLBACK_PROVIDER?.trim() || "openrouter",
        ...(env.WILDBOTS_FALLBACK_CREDENTIAL?.trim()
          ? { credentialId: env.WILDBOTS_FALLBACK_CREDENTIAL.trim() }
          : {}),
      };
    }
    config.nativeHarness = {
      workspaceRoot,
      ...(fallback ? { fallback } : {}),
    };
  }
  if (env.IOS_APP_LATEST_BUILD || env.IOS_APP_UPDATE_URL) {
    if (!env.IOS_APP_LATEST_BUILD || !env.IOS_APP_UPDATE_URL)
      throw new Error("IOS_APP_LATEST_BUILD and IOS_APP_UPDATE_URL must be supplied together");
    if (!/^[1-9][0-9]{0,8}$/.test(env.IOS_APP_LATEST_BUILD))
      throw new Error(
        "IOS_APP_LATEST_BUILD must be the whole-number CFBundleVersion of the latest distributed build",
      );
    let url: URL | undefined;
    try {
      url = new URL(env.IOS_APP_UPDATE_URL);
    } catch {
      /* Reported below. */
    }
    if (url?.protocol !== "https:")
      throw new Error("IOS_APP_UPDATE_URL must be an HTTPS link, such as a TestFlight invitation");
    config.nativeApp = { latestBuild: Number(env.IOS_APP_LATEST_BUILD), updateUrl: url.href };
  }
  return config;
}

export function allowedIdentity(config: Config, user: { id: string; email: string }) {
  return user.id.startsWith("local-")
    ? config.localDevAuth && !config.production && ["local-one", "local-two"].includes(user.id)
    : config.householdEmails.includes(user.email.toLowerCase());
}
