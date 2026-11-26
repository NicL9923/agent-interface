import type { BuildManifestEntry } from "./precache-plan.mjs";

export interface BundleBudgetLimit {
  maxJsGzipBytes?: number;
  maxCssGzipBytes?: number;
  maxTotalGzipBytes?: number;
}

export interface BundleClosureMeasurement {
  key: string;
  jsBytes: number;
  cssBytes: number;
  totalBytes: number;
  files: string[];
}

export declare function closureFiles(
  manifest: Record<string, BuildManifestEntry>,
  entryKey: string,
): string[];

export declare function measureBundleClosures(
  manifest: Record<string, BuildManifestEntry>,
  readBuffer: (file: string) => Uint8Array,
  keys: string[],
): BundleClosureMeasurement[];

export declare function checkBundleBudget(options: {
  manifest: Record<string, BuildManifestEntry>;
  readBuffer: (file: string) => Uint8Array;
  budgets: Record<string, BundleBudgetLimit>;
}): BundleClosureMeasurement[];
