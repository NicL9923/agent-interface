export type VaultSourceName = 'local' | 'onepassword' | 'bitwarden';
export interface VaultLogin {
  id: string;
  kind: 'login';
  label: string;
  origin: string;
  createdAt: string;
  identifier: string;
  identifierType: 'email' | 'phone' | 'username';
  hasOtp: boolean;
  backend: VaultSourceName;
  canRemove: boolean;
}
export interface VaultSource {
  name: VaultSourceName;
  displayName: string;
  enabled: boolean;
  needsUnlock: boolean;
  unlocked: boolean;
  installed: boolean;
  canToggle: boolean;
  canUnlock: boolean;
  canLock: boolean;
}
export interface ProfileVault {
  botId: string;
  profile: string;
  scope: 'profile';
  owner: 'Hermes';
  notice: string;
  items: VaultLogin[];
  sources: VaultSource[];
}
export interface AddVaultLogin {
  label: string;
  origin: string;
  identifierType: 'email' | 'phone' | 'username';
  identifier: string;
  password: string;
  otpSecret?: string;
}
export type SecureRequestMethod = 'vault.save_login' | 'vault.code' | 'vault.unlock_prompt' | 'secret';
interface SecureRequestOwner { epoch: string; sessionId: string }
/** A login the assistant asked for by address, with no browser page. Its text comes from the assistant. */
export interface ExplicitLoginRequest {
  label: string;
  purpose: string;
  profile: string;
  /** The member whose task asked. Only they may answer or cancel. */
  requestedBy?: { id: string; name?: string };
}
export type SecureRequest = SecureRequestOwner & (
  | { method: 'vault.save_login'; origin: string; site: string; explicit?: ExplicitLoginRequest }
  | { method: 'vault.code'; site?: string; hint?: string }
  | { method: 'vault.unlock_prompt'; backend: 'onepassword' | 'bitwarden'; displayName: string }
  | { method: 'secret'; envVar: string; prompt: string }
);
export type SecureRequestAnswer = SecureRequestOwner & (
  | { method: SecureRequestMethod; cancel: true }
  /** An explicit-origin answer repeats the destination its card showed. */
  | { method: 'vault.save_login'; identifier: string; password: string; origin?: string }
  | { method: 'vault.code' | 'vault.unlock_prompt' | 'secret'; value: string }
);
export type VaultRequest =
  | { operation: 'overview'; profile: string }
  | { operation: 'add_login'; profile: string; login: AddVaultLogin }
  | { operation: 'remove_login'; profile: string; itemId: string }
  | { operation: 'source'; profile: string; source: 'onepassword' | 'bitwarden'; enabled: boolean }
  | { operation: 'unlock'; profile: string; source: 'onepassword' | 'bitwarden'; password: string }
  | { operation: 'lock'; profile: string; source: 'onepassword' | 'bitwarden' }
  /** actor is the signed-in member, added by the server. */
  | { operation: 'answer'; profile: string; requestId: string; answer: SecureRequestAnswer; actor: string };
export type VaultResponse = ProfileVault | { id: string } | { removed: boolean } | { ok: true } | { status: 'ok' | 'expired' };
