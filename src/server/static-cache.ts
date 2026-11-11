import { relative, sep } from "node:path";

// Vite writes bundles to assets/<name>-<hash>.<ext>, hashed from their content, so one URL is
// one body forever. Nothing else qualifies: public/ has no assets directory, and index.html,
// sw.js, the manifest and the icons keep one name across releases, so they must revalidate.
const hashedAsset = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
export const immutableCacheControl = "public, max-age=31536000, immutable";

const clientPath = (root: string, file: string) => relative(root, file).split(sep).join("/");
export function isHashedAsset(root: string, file: string) {
  return hashedAsset.test(clientPath(root, file));
}

// The pages, the worker and public/boot.js keep one name across releases, and each must be the copy
// of the release that loads it, so a browser asks the server before reusing one.
const revalidated = new Set(["index.html", "native-computer.html", "native-terminal.html", "sw.js", "boot.js"]);
export function mustRevalidate(root: string, file: string) {
  return revalidated.has(clientPath(root, file));
}
