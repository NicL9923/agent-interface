export interface BuildManifestEntry {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  css?: string[];
}
export function precachePlan(
  manifest: Record<string, BuildManifestEntry>,
  files: string[],
): { precache: string[]; onDemand: string[] };
