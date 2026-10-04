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
  hermesUrl?: string;
  hermesToken?: string;
  hermesAuthMode: "static" | "service";
  hermesQualificationFile?: string;
  /** Unset in embedded and test servers, which stay silent; the entrypoint defaults to info. */
  logLevel?: LogLevel;
  integrationAdmins?: string[];
  computerTerminal?: { stateDirectory: string; cwd: string; python: string };
  hermesUpgrade?: {
    stateDirectory: string;
    workerConfig: string;
    python: string;
    adminEmails: string[];
  };
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
export const loopback = (host: string) =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
export function parseAppOrigin(value: string): URL {
  let origin: URL;
  try { origin = new URL(value); }
  catch { throw new Error("APP_ORIGIN must be a valid HTTP or HTTPS origin, including its protocol"); }
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
    hermesUrl: env.HERMES_URL,
    hermesToken: env.HERMES_TOKEN,
    hermesAuthMode: (env.HERMES_AUTH_MODE || "static") as "static" | "service",
    hermesQualificationFile: env.HERMES_QUALIFICATION_FILE || undefined,
    logLevel: (env.LOG_LEVEL || undefined) as LogLevel | undefined,
  };
  if (config.logLevel && !logLevels.includes(config.logLevel))
    throw new Error(`LOG_LEVEL must be one of ${logLevels.join(", ")}`);
  const origin = parseAppOrigin(config.origin);
  if (env.COMPUTER_TERMINAL_ENABLED && !["true", "false"].includes(env.COMPUTER_TERMINAL_ENABLED))
    throw new Error("COMPUTER_TERMINAL_ENABLED must be true or false");
  if (env.COMPUTER_TERMINAL_ENABLED === "true") {
    if (![env.COMPUTER_STATE_DIR, env.COMPUTER_TERMINAL_CWD, env.COMPUTER_PYTHON].every(path => path?.startsWith("/") && !path.includes("\0")))
      throw new Error("The computer terminal requires absolute state, workspace and Python paths");
    config.computerTerminal = { stateDirectory: env.COMPUTER_STATE_DIR!, cwd: env.COMPUTER_TERMINAL_CWD!, python: env.COMPUTER_PYTHON! };
  }
  if (env.HERMES_UPGRADE_ENABLED && !["true", "false"].includes(env.HERMES_UPGRADE_ENABLED))
    throw new Error("HERMES_UPGRADE_ENABLED must be true or false");
  if (env.HERMES_UPGRADE_ENABLED === "true") {
    const adminEmails = (env.HERMES_UPGRADE_ADMINS ?? "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.length || !env.HERMES_UPGRADE_CONFIG || !env.HERMES_UPGRADE_STATE_DIR || !env.HERMES_UPGRADE_PYTHON)
      throw new Error("Hermes upgrades require explicit administrators, private worker configuration, state directory and Python interpreter");
    if (![env.HERMES_UPGRADE_CONFIG, env.HERMES_UPGRADE_STATE_DIR, env.HERMES_UPGRADE_PYTHON].every(x => x!.startsWith("/")))
      throw new Error("Hermes upgrade paths must be absolute");
    config.hermesUpgrade = { adminEmails, workerConfig: env.HERMES_UPGRADE_CONFIG,
      stateDirectory: env.HERMES_UPGRADE_STATE_DIR, python: env.HERMES_UPGRADE_PYTHON };
  }
  if (!["static", "service"].includes(config.hermesAuthMode)) throw new Error("HERMES_AUTH_MODE must be static or service");
  if (config.hermesAuthMode === "service" && config.hermesToken && !/^[A-Za-z0-9_-]{43}$/.test(config.hermesToken))
    throw new Error("HERMES_TOKEN must be the private 32-byte base64url service key in service mode");
  config.production =
    config.production || !loopback(config.host) || !loopback(origin.hostname);
  if (config.hermesUpgrade && config.production && config.hermesUpgrade.adminEmails.some(email => !config.householdEmails.includes(email)))
    throw new Error("Hermes upgrade administrators must belong to the household allowlist");
  config.integrationAdmins = env.HERMES_INTEGRATION_ADMINS === undefined
    ? config.hermesUpgrade?.adminEmails ?? []
    : [...new Set(env.HERMES_INTEGRATION_ADMINS.split(",").map(email => email.trim().toLowerCase()).filter(Boolean))];
  if (config.production && config.integrationAdmins.some(email => !config.householdEmails.includes(email)))
    throw new Error("Integration administrators must belong to the household allowlist");
  if (
    config.localDevAuth &&
    (config.production || !loopback(config.host) || !loopback(origin.hostname))
  )
    throw new Error(
      "Local development auth requires development mode and a loopback host and origin",
    );
  if (
    config.production &&
    (origin.protocol !== "https:" ||
      !config.googleClientId ||
      !config.householdEmails.length)
  )
    throw new Error(
      "Production requires HTTPS, Google client ID, and an explicit household allowlist",
    );
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error("Invalid port");
  if (
    [config.vapidPublicKey, config.vapidPrivateKey, config.vapidSubject].some(
      Boolean,
    ) &&
    ![config.vapidPublicKey, config.vapidPrivateKey, config.vapidSubject].every(
      Boolean,
    )
  )
    throw new Error("All VAPID settings must be supplied together");
  const apns = [env.APNS_TEAM_ID, env.APNS_KEY_ID, env.APNS_TOPIC, env.APNS_PRIVATE_KEY_FILE];
  if (apns.some(Boolean)) {
    if (!apns.every(Boolean)) throw new Error("All APNs signing settings must be supplied together");
    if (!/^[A-Z0-9]{10}$/.test(env.APNS_TEAM_ID!) || !/^[A-Z0-9]{10}$/.test(env.APNS_KEY_ID!))
      throw new Error("APNs team and key IDs must contain 10 uppercase letters or digits");
    if (!/^[A-Za-z0-9.-]{1,255}$/.test(env.APNS_TOPIC!)) throw new Error("Invalid APNs bundle ID");
    if (!["sandbox", "production"].includes(env.APNS_ENVIRONMENT ?? ""))
      throw new Error("APNS_ENVIRONMENT must be sandbox or production when APNs is configured");
    config.apns = { teamId: env.APNS_TEAM_ID!, keyId: env.APNS_KEY_ID!, topic: env.APNS_TOPIC!,
      privateKeyFile: env.APNS_PRIVATE_KEY_FILE!, environment: env.APNS_ENVIRONMENT as "sandbox" | "production" };
  } else if (env.APNS_ENVIRONMENT) throw new Error("APNs signing settings are required with APNS_ENVIRONMENT");
  return config;
}

export function allowedIdentity(
  config: Config,
  user: { id: string; email: string },
) {
  return user.id.startsWith("local-")
    ? config.localDevAuth &&
        !config.production &&
        ["local-one", "local-two"].includes(user.id)
    : config.householdEmails.includes(user.email.toLowerCase());
}
