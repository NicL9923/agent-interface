import { providerIconKey, providerIconPaths } from "../shared/provider-icon";

/** A small monochrome provider mark in the current text color. The name beside it is the label, so it is decorative. */
export function ProviderIcon({ provider, size = 14, className }: { provider?: string; size?: number; className?: string }) {
  const key = providerIconKey(provider);
  return <svg className={className} data-provider-icon={key} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    <path d={providerIconPaths[key]} />
  </svg>;
}
