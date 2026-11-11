import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

// Vite writes bundles to assets/<name>-<hash>.<ext>, hashed from their content, so one URL is
// one body forever. Nothing else qualifies: public/ has no assets directory, and index.html,
// sw.js, the manifest and the icons keep one name across releases, so they must revalidate.
const hashedName = /^[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
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

// A page that opened under the previous release keeps asking for that release's hashed files after a
// deploy replaces it. The deploy tooling (`Deployment.switch` in .agents/tools/deploy_common.py) writes
// dist/previous-release.json into the release it activates, naming the assets directory of the release
// it replaces: {"assets": "/absolute/path/to/releases/release-X/dist/client/assets"}. A hashed name the
// live release no longer has is answered from there, so one release of grace is as long as that release's
// directory lives, and release-app.py keeps the rollback target. The directory is never guessed.
export type PreviousAssets = { readonly directory: string };

/** The assets directory the deploy tooling named, or undefined when none is named or the file is unusable. */
export function readPreviousAssets(file: string, warn: (message: string) => void = () => {}): PreviousAssets | undefined {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(`Ignoring ${file}: ${(error as Error).message}`);
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const directory = parsed && typeof parsed === "object" ? (parsed as { assets?: unknown }).assets : undefined;
    if (typeof directory === "string" && isAbsolute(directory)) return { directory };
  } catch { /* Reported below. */ }
  warn(`Ignoring ${file}: it must be an object whose "assets" is an absolute path`);
  return undefined;
}

/** The previous release's real assets directory, or undefined when it is not there (pruned, or never made). */
function previousRoot(previous: PreviousAssets) {
  try { return realpathSync(previous.directory); } catch { return undefined; }
}

/** Whether `file`, as @fastify/static found it, was sent from the previous release's directory by previousAssetFile, so is as immutable as a live asset. */
export function isPreviousAsset(previous: PreviousAssets | undefined, file: string) {
  const root = previous && previousRoot(previous);
  return root !== undefined && dirname(file) === root;
}

/**
 * The previous release's file to send for a request path, or undefined for a 404.
 * Only a hashed name directly in the directory qualifies, and only a regular file that really lives
 * there: a link that leads out of the directory, or a directory named like an asset, is refused.
 */
export function previousAssetFile(previous: PreviousAssets | undefined, pathname: string): { name: string; root: string } | undefined {
  if (!previous || !pathname.startsWith("/assets/")) return undefined;
  let name: string;
  try { name = decodeURIComponent(pathname.slice("/assets/".length)); } catch { return undefined; }
  // A hashed name holds no slash, so it cannot climb out of the directory or reach a subdirectory.
  if (!hashedName.test(name)) return undefined;
  const root = previousRoot(previous);
  if (root === undefined) return undefined;
  try {
    const file = realpathSync(join(root, name));
    return file.startsWith(root + sep) && statSync(file).isFile() ? { name, root } : undefined;
  } catch { return undefined; }
}
