import type { Plugin } from "vite";

export interface OutputChunkLike {
  type: "chunk";
  fileName?: string;
  name?: string;
  isEntry?: boolean;
  facadeModuleId?: string | null;
  imports?: string[];
  modules?: Record<string, unknown>;
  moduleIds?: string[];
}

export interface OutputAssetLike {
  type: "asset";
  fileName?: string;
}

export type OutputBundleLike = Record<string, OutputChunkLike | OutputAssetLike>;

export interface ChunkCycleGuardOptions {
  bannedPackages?: string[];
  entryMatcher?: (chunk: OutputChunkLike) => boolean;
}

export declare const DEFAULT_BANNED_ENTRY_PACKAGES: readonly string[];
export declare function assertNoChunkCycles(bundle: OutputBundleLike): void;
export declare function assertNoBannedEntryImports(
  bundle: OutputBundleLike,
  options?: ChunkCycleGuardOptions,
): void;
export declare function chunkCycleGuardPlugin(options?: ChunkCycleGuardOptions): Plugin;
