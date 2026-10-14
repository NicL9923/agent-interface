import { relative, sep } from "node:path";

// Vite writes bundles to assets/<name>-<hash>.<ext>, hashed from their content, so one URL is
// one body forever. Nothing else qualifies: public/ has no assets directory, and index.html,
// sw.js, the manifest and the icons keep one name across releases, so they must revalidate.
const hashedAsset = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
export const immutableCacheControl = "public, max-age=31536000, immutable";

export function isHashedAsset(root: string, file: string) {
  return hashedAsset.test(relative(root, file).split(sep).join("/"));
}
