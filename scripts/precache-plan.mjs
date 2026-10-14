// Packages whose code only administrators run: the terminal and the remote desktop.
const onDemandSources = /^node_modules\/@(?:novnc|xterm)\//;

/**
 * Splits built files into those every device caches at install and those cached on first use.
 * `manifest` is Vite's build manifest. Chunks loaded only through the admin-only dynamic
 * imports, and anything only they import, stay out of the install cache; whatever the entry
 * also needs stays in it.
 */
export function precachePlan(manifest, files) {
  const reach = (keys) => {
    const seen = new Set();
    const visit = (key) => {
      if (seen.has(key) || !manifest[key]) return;
      seen.add(key);
      for (const next of manifest[key].imports ?? []) visit(next);
    };
    keys.forEach(visit);
    return seen;
  };
  const filesOf = (keys) => new Set([...keys].flatMap((key) => [manifest[key].file, ...(manifest[key].css ?? [])]));
  const roots = Object.keys(manifest).filter((key) => onDemandSources.test(key) && manifest[key].isDynamicEntry);
  // A silent mismatch would put 500 KB back on every phone, so a renamed or removed import fails the build.
  if (!roots.length) throw new Error('The build has no terminal or remote desktop chunks to keep out of the install cache.');
  const eager = filesOf(reach(Object.keys(manifest).filter((key) => manifest[key].isEntry)));
  const onDemand = [...filesOf(reach(roots))].filter((file) => !eager.has(file));
  const excluded = new Set(onDemand);
  return { precache: files.filter((file) => !excluded.has(file)), onDemand: files.filter((file) => excluded.has(file)) };
}
