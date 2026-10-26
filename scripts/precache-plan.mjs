// Packages whose code only administrators run: the terminal and the remote desktop.
const onDemandSources = /^node_modules\/@(?:novnc|xterm)\//;
// The context menu's popup library: its production build names its error page and tags its markup.
const popupLibraryMarkers = /base-ui\.com\/production-error|data-base-ui-/;

const reach = (manifest, keys) => {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key) || !manifest[key]) return;
    seen.add(key);
    for (const next of manifest[key].imports ?? []) visit(next);
  };
  keys.forEach(visit);
  return seen;
};
const filesOf = (manifest, keys) => new Set([...keys].flatMap((key) => [manifest[key].file, ...(manifest[key].css ?? []), ...(manifest[key].assets ?? [])]));
/** The files every page load needs: the static import graph of each HTML entry. */
const eagerFiles = (manifest) => filesOf(manifest, reach(manifest, Object.keys(manifest).filter((key) => manifest[key].isEntry)));

/**
 * Fails the build when the popup library is back in what every page load downloads. It is only
 * needed once someone opens a menu, so it loads on first use; a stray static import of a Base UI
 * component would quietly put it back in front of first paint. `read` returns a built file's text.
 */
export function assertPopupLibraryIsLazy(manifest, read) {
  const offenders = [...eagerFiles(manifest)].filter((file) => file.endsWith('.js') && popupLibraryMarkers.test(read(file)));
  if (offenders.length) throw new Error(`The popup library (Base UI) is in the entry's static imports (${offenders.join(', ')}). Import its components only from lazily loaded modules.`);
}

/**
 * Sorts built files by when a device fetches them. `manifest` is Vite's build manifest.
 * - `install`: the pages and the static import graph of each HTML entry, the files needed to open
 *   offline, plus anything the manifest does not know, such as icons. Fetched while installing.
 * - `warm`: the other chunks, such as lazy screens. Fetched in the background after activation.
 * - `onDemand`: chunks loaded only through the admin-only dynamic imports, and anything only they
 *   import. Fetched when first used.
 */
export function precachePlan(manifest, files) {
  const roots = Object.keys(manifest).filter((key) => onDemandSources.test(key) && manifest[key].isDynamicEntry);
  // A silent mismatch would put 500 KB back on every phone, so a renamed or removed import fails the build.
  if (!roots.length) throw new Error('The build has no terminal or remote desktop chunks to keep out of the install cache.');
  const eager = eagerFiles(manifest);
  if (!eager.size) throw new Error('The build has no HTML entries to install.');
  const adminOnly = new Set([...filesOf(manifest, reach(manifest, roots))].filter((file) => !eager.has(file)));
  const lazy = new Set([...filesOf(manifest, Object.keys(manifest))].filter((file) => !eager.has(file) && !adminOnly.has(file)));
  return {
    install: files.filter((file) => !lazy.has(file) && !adminOnly.has(file)),
    warm: files.filter((file) => lazy.has(file)),
    onDemand: files.filter((file) => adminOnly.has(file)),
  };
}
