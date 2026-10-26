export interface BuildManifestEntry {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  css?: string[];
  assets?: string[];
}
export function precachePlan(
  manifest: Record<string, BuildManifestEntry>,
  files: string[],
): { install: string[]; warm: string[]; onDemand: string[] };
export function assertPopupLibraryIsLazy(
  manifest: Record<string, BuildManifestEntry>,
  read: (file: string) => string,
): void;
