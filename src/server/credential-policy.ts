import { Conflict, InvalidInput } from "../shared/errors.js";
import {
  CREDENTIAL_KINDS,
  NATIVE_HARNESS_KINDS,
  type CredentialRecord,
  type ManagedBotRecord,
} from "../shared/harness.js";

export type CredentialUse =
  | { kind: "configure" }
  | { kind: "group-chat"; multiUser: boolean }
  | { kind: "handoff"; sourceOwnerId?: string }
  | { kind: "routine"; destination: "personal" | "group" };

export function assertCredentialConfiguration(
  credential: Pick<CredentialRecord, "kind" | "ownerId" | "allowedHarnesses" | "envVar">,
): void {
  if (!CREDENTIAL_KINDS.includes(credential.kind))
    throw new InvalidInput("Choose a subscription or API key credential.");
  if (
    !Array.isArray(credential.allowedHarnesses) ||
    !credential.allowedHarnesses.every((kind) => NATIVE_HARNESS_KINDS.includes(kind))
  )
    throw new InvalidInput("Choose only supported native harnesses for this credential.");
  if (credential.kind === "subscription") {
    if (typeof credential.ownerId !== "string" || !credential.ownerId.trim())
      throw new InvalidInput("Set an owner for this subscription credential.");
    if (credential.envVar !== undefined)
      throw new InvalidInput("Sign in through the vendor CLI to set up a subscription credential.");
  } else if (
    credential.envVar !== undefined &&
    (typeof credential.envVar !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(credential.envVar))
  ) {
    throw new InvalidInput("Enter the environment variable name for this API key.");
  }
}

/** Checks the proposed bot configuration and its use. Supply context from server-owned chat and bot records. */
export function assertCredentialPolicy(
  bot: Pick<ManagedBotRecord, "harness" | "ownerId" | "ownerOsUser" | "shared">,
  credential: Pick<CredentialRecord, "kind" | "ownerId" | "allowedHarnesses" | "envVar" | "osUser">,
  use: CredentialUse,
): void {
  assertCredentialConfiguration(credential);
  if (!credential.allowedHarnesses.some((harness) => harness === bot.harness))
    throw new InvalidInput(`Choose a credential that supports the ${bot.harness} harness.`);
  if (credential.kind === "api_key") return;

  if (bot.shared !== false) throw new InvalidInput("Use an API key credential for a shared bot.");
  if (bot.ownerId !== credential.ownerId)
    throw new InvalidInput("Choose a subscription credential owned by this bot's owner.");
  if (credential.osUser !== undefined && bot.ownerOsUser !== credential.osUser)
    throw new InvalidInput("Run this bot under the Unix account that owns the subscription login.");

  switch (use.kind) {
    case "configure":
      return;
    case "group-chat":
      if (use.multiUser !== false)
        throw new Conflict(
          "Use a bot with an API key credential in a group chat with other members.",
        );
      return;
    case "handoff":
      if (use.sourceOwnerId !== bot.ownerId)
        throw new Conflict(
          "Use a bot with an API key credential for handoffs between members' bots.",
        );
      return;
    case "routine":
      if (use.destination !== "personal")
        throw new Conflict(
          "Use a bot with an API key credential for routines that post to group chats.",
        );
      return;
    default:
      throw new InvalidInput("Choose where this subscription credential will be used.");
  }
}
