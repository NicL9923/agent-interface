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
}
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
  };
  const origin = parseAppOrigin(config.origin);
  config.production =
    config.production || !loopback(config.host) || !loopback(origin.hostname);
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
